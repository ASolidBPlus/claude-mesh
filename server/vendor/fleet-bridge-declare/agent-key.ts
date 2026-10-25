// Agent-key callers: an identity (an agent or a service) proves itself on every HTTP request by
// signing it with its own identity key, as `ssh-keygen -Y sign -n bridge-v1` makes it. The app
// checks the signature against the key its key source lists for that name. Moved here from
// W-1416's held door, so the signer (fleet-mcp's MCP face) and every app share one format:
//
//   X-Bridge-Identity  the caller's name
//   X-Bridge-Ts        unix milliseconds; within 60 s of the app's clock
//   X-Bridge-Nonce     [A-Za-z0-9_-]{16,64}; never accepted twice within the window
//   X-Bridge-Sig       base64 of the binary SSHSIG over
//                      bridge-v1\n<name>\n<system>\n<METHOD>\n<path>\n<query>\n<sha256 hex of body>\n<ts>\n<nonce>
//
// <system> is the app the request is for, and the app checks it is its own: every app has the
// same paths, so without it one app could replay an agent's request to another. Each field is checked against its form before it goes into the message, so none can carry a
// newline. Where the keys come from is the app's choice of KeySource: a list read from an
// identity service (listKeySource) or a fixed list from the app's own config (staticKeySource).
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CallerCheck } from './callers.ts';
import { pinnedFetchOptions } from './pin.ts';
import { blobFromPublicKeyLine, verifySshsig } from './sshsig.ts';
import { CALLER_RE, SYSTEM_RE } from './vouch.ts';

export const AGENT_KEY_NAMESPACE = 'bridge-v1';
export const AGENT_KEY_WINDOW_MS = 60_000;
export const AGENT_KEY_HEADERS = { identity: 'x-bridge-identity', ts: 'x-bridge-ts', nonce: 'x-bridge-nonce', sig: 'x-bridge-sig' } as const;
const TS_RE = /^[0-9]{13}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const SIG_RE = /^[A-Za-z0-9+/]{1,700}={0,2}$/;
const METHOD_RE = /^[A-Z]{3,7}$/;

/** The exact bytes the caller signs. `path` and `query` are as sent (query without its `?`). */
export function agentKeyMessage(f: { name: string; system: string; method: string; path: string; query: string; body: Uint8Array; ts: string; nonce: string }): string {
  if (!SYSTEM_RE.test(f.system)) throw new Error(`agentKeyMessage: system "${f.system}" is not of the form ${SYSTEM_RE}`);
  const bodyHash = createHash('sha256').update(f.body).digest('hex');
  return [AGENT_KEY_NAMESPACE, f.name, f.system, f.method.toUpperCase(), f.path, f.query, bodyHash, f.ts, f.nonce].join('\n');
}

/** One identity a key source knows: `id` is what access is asked by, `name` what it signs as. */
export interface KeyHolder {
  id: string;
  name: string;
  /** The ssh-ed25519 public key blob. */
  blob: Buffer;
}

export interface KeySource {
  /** The holder of `name`; null if there is none; 'failed' when the list can't be trusted now. */
  lookup(name: string): KeyHolder | null | 'failed';
}

/** A fixed list from the app's own config: [{id, name, key: "ssh-ed25519 AAAA..."}]. Throws on a bad entry. */
export function staticKeySource(entries: { id: string; name: string; key: string }[]): KeySource {
  const byName = new Map<string, KeyHolder>();
  for (const e of entries) {
    if (!CALLER_RE.test(e.id) || !CALLER_RE.test(e.name)) throw new Error(`staticKeySource: "${e.name}" (${e.id}) is not of the caller form ${CALLER_RE}`);
    if (byName.has(e.name)) throw new Error(`staticKeySource: ${e.name} is listed twice`);
    const blob = blobFromPublicKeyLine(e.key);
    if (blob === null) throw new Error(`staticKeySource: ${e.name}'s key is not an ssh-ed25519 public key`);
    byName.set(e.name, { id: e.id, name: e.name, blob });
  }
  return { lookup: (name) => byName.get(name) ?? null };
}

/** The list a listKeySource reads: identities, each with its keys. */
export const KeyListSchema = z.object({
  identities: z.array(
    z.object({
      id: z.string().min(1).max(64),
      username: z.string().min(1).max(128),
      kind: z.string(),
      keys: z.array(z.object({ type: z.string(), key: z.string(), source: z.string() })),
    }),
  ),
});

/**
 * The holders in a list. `keySources` says, per identity kind, which key source signs as it (an
 * agent by its "agent-identity" key, say); a kind not named there never signs in. An identity
 * with no such key, or more than one, is left out, and so is any name two identities share.
 */
export function holdersOf(body: unknown, keySources: Record<string, string>): Map<string, KeyHolder> | null {
  const r = KeyListSchema.safeParse(body);
  if (!r.success) return null;
  const out = new Map<string, KeyHolder>();
  const seen = new Set<string>();
  for (const i of r.data.identities) {
    if (seen.has(i.username)) {
      out.delete(i.username);
      continue;
    }
    seen.add(i.username);
    const source = Object.hasOwn(keySources, i.kind) ? keySources[i.kind] : undefined;
    if (source === undefined || !CALLER_RE.test(i.id) || !CALLER_RE.test(i.username)) continue;
    const keys = i.keys.filter((k) => k.source === source && k.type === 'ssh-ed25519');
    const blob = keys.length === 1 ? blobFromPublicKeyLine(`ssh-ed25519 ${keys[0]!.key}`) : null;
    if (blob) out.set(i.username, { id: i.id, name: i.username, blob });
  }
  return out;
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * A list read over HTTP (POST <url>, bearer token), refreshed by the app calling refresh() on a
 * timer. Fail closed: before the first good read, or once the last good read is older than
 * staleMs, every lookup is 'failed' and every request is refused. An empty list is only ever one
 * the service actually returned.
 */
export function listKeySource(opts: {
  url: string;
  token: string;
  keySources: Record<string, string>;
  ca?: string | undefined;
  fetch?: Fetch | undefined;
  now?: (() => number) | undefined;
  staleMs?: number | undefined;
  timeoutMs?: number | undefined;
}): KeySource & { refresh(): Promise<void> } {
  const fetchFn: Fetch = opts.fetch ?? ((u, i) => fetch(u, i));
  const now = opts.now ?? Date.now;
  const staleMs = opts.staleMs ?? 90_000;
  let list: Map<string, KeyHolder> | null = null;
  let readAt = 0;
  return {
    lookup(name) {
      if (list === null || now() - readAt > staleMs) return 'failed';
      return list.get(name) ?? null;
    },
    async refresh() {
      try {
        const r = await fetchFn(opts.url, {
          method: 'POST',
          headers: { authorization: `Bearer ${opts.token}`, 'content-type': 'application/json' },
          body: '{}',
          redirect: 'manual',
          signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
          ...(opts.ca ? pinnedFetchOptions(opts.ca) : {}),
        } as RequestInit);
        if (r.status !== 200) return;
        const next = holdersOf(await r.json(), opts.keySources);
        if (next === null) return;
        list = next;
        readAt = now();
      } catch {
        // keep the last good list until it goes stale
      }
    },
  };
}

/**
 * Nonces seen within the window, kept per caller and capped per caller (W-1441): one key that
 * fills its own book is refused, and every other caller carries on. Full means refuse: a nonce
 * is never forgotten early. Only a caller whose signature verified gets a book.
 */
export class NonceBook {
  private books = new Map<string, Map<string, number>>();
  constructor(
    private readonly windowMs = AGENT_KEY_WINDOW_MS,
    private readonly perCaller = 2_000,
  ) {}
  /** true the first time (caller, nonce) is offered within the window. */
  take(caller: string, nonce: string, nowMs: number): boolean {
    let book = this.books.get(caller);
    if (book === undefined) this.books.set(caller, (book = new Map()));
    const until = book.get(nonce);
    if (until !== undefined && until > nowMs) return false;
    if (book.size >= this.perCaller) {
      for (const [n, t] of book) if (t <= nowMs) book.delete(n);
      if (book.size >= this.perCaller) return false;
    }
    // a signature stays valid for windowMs either side of its ts, so remember it for both
    book.set(nonce, nowMs + 2 * this.windowMs);
    return true;
  }
}

/**
 * Agent-key mode: each request signed by the caller's own identity key, as its key source lists
 * it. A request signed before `bootMs` (default: when this was made) is refused, because the
 * nonces seen before a restart are gone and such a request could otherwise be replayed.
 */
export function agentKeyCallers(keys: KeySource, opts: { bootMs?: number | undefined } = {}): CallerCheck {
  if (typeof keys?.lookup !== 'function') throw new Error('agentKeyCallers: a key source is required');
  const bootMs = opts.bootMs ?? Date.now();
  const nonces = new NonceBook();
  return {
    mode: 'agent-key',
    check: (r) => {
      const h = (n: string) => r.headers.get(n);
      const name = h(AGENT_KEY_HEADERS.identity);
      const ts = h(AGENT_KEY_HEADERS.ts);
      const nonce = h(AGENT_KEY_HEADERS.nonce);
      const sig = h(AGENT_KEY_HEADERS.sig);
      if (name === null || ts === null || nonce === null || sig === null) return { ok: false, reason: 'missing signature headers' };
      if (!CALLER_RE.test(name) || !TS_RE.test(ts) || !NONCE_RE.test(nonce) || !SIG_RE.test(sig) || !METHOD_RE.test(r.method)) {
        return { ok: false, reason: 'a signature header outside its form' };
      }
      if (Math.abs(r.nowMs - Number(ts)) > AGENT_KEY_WINDOW_MS) return { ok: false, reason: 'the signature is outside the 60 s window' };
      if (Number(ts) < bootMs) return { ok: false, reason: 'the signature is from before this service started' };
      const holder = keys.lookup(name);
      if (holder === 'failed') return { ok: false, reason: 'the key list is unavailable' };
      if (holder === null) return { ok: false, reason: `no key is listed for ${name}` };
      // signed for this app by name: a request signed for another app never verifies here
      const message = agentKeyMessage({ name, system: r.system, method: r.method, path: r.path, query: r.query, body: r.body, ts, nonce });
      const v = verifySshsig(Buffer.from(sig, 'base64'), Buffer.from(message, 'utf8'), AGENT_KEY_NAMESPACE, holder.blob);
      if (!v.ok) return { ok: false, reason: `the signature does not verify (${v.cls})` };
      // only a verified request spends its nonce, so a forger can't burn a real one
      if (!nonces.take(name, nonce, r.nowMs)) return { ok: false, reason: 'the nonce was already used' };
      return { ok: true, caller: holder.id, callerName: holder.name };
    },
  };
}
