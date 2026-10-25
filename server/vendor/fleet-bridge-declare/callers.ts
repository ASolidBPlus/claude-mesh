// Who may call: the pluggable caller check an app's door requires. An app picks one explicitly;
// there is no default, so leaving it out never lets anyone in. Over HTTP (serveActions):
//   agentKeyCallers(keys)  each request signed with the caller's own identity key (agent-key.ts)
//   bearerCallers(tokens)  each caller has its own bearer token, from the app's config
//   bridgeCallers(keys)    a bridge's vouch, its keys pinned (vouch.ts)
// Over the mesh (serveMeshActions, mesh.ts) the one check is meshCallers(): the mesh's stamped
// sender. The routes, the declaration and the codes are the same whichever is used.
import { createHash, timingSafeEqual } from 'node:crypto';
import { CALLER_HEADER, CALLER_RE, NonceCache, VOUCH_HEADER, parseBridgeKey, verifyVouch } from './vouch.ts';

/** `caller` is the id access is checked by; `callerName` the name to show, and its mesh address. */
export type CallerResult = { ok: true; caller: string; callerName: string } | { ok: false; reason: string };

export interface CallerRequest {
  system: string;
  /** The action called, or DECLARATION_ACTION for the declaration read. */
  action: string;
  method: string;
  path: string;
  /** The query string as sent, without its `?`. */
  query: string;
  headers: Headers;
  body: Uint8Array;
  nowMs: number;
}

export interface CallerCheck {
  readonly mode: string;
  check(r: CallerRequest): CallerResult;
}

/**
 * Bridge mode: the bridge's pinned public keys (base64url, 32 bytes each); any one verifying is
 * enough. A vouch from before `bootMs` (default: when this was made) is refused (W-1441).
 */
export function bridgeCallers(bridgeKeys: string[], opts: { bootMs?: number | undefined } = {}): CallerCheck {
  if (!Array.isArray(bridgeKeys) || bridgeKeys.length === 0) throw new Error('bridgeCallers: at least one bridge key is required');
  const keys = bridgeKeys.map(parseBridgeKey);
  const bootMs = opts.bootMs ?? Date.now();
  const nonces = new NonceCache();
  return {
    mode: 'bridge',
    check: (r) => {
      const v = verifyVouch({ keys, system: r.system, action: r.action, header: r.headers.get(VOUCH_HEADER), callerHeader: r.headers.get(CALLER_HEADER), body: r.body, nowMs: r.nowMs, nonces, bootMs });
      return v.ok ? { ok: true, caller: v.caller, callerName: v.caller } : v;
    },
  };
}

const TOKEN_RE = /^[A-Za-z0-9._~+/=-]{16,512}$/;
const sha256 = (s: string) => createHash('sha256').update(s).digest();

/**
 * Standalone mode: `Authorization: Bearer <token>`, one token per caller. The config holds each
 * caller's sha256 (hex) of its token, never the token, e.g. {"alice": "<64 hex>"}. A bearer
 * caller's name is its id.
 */
export function bearerCallers(tokenSha256ByCaller: Record<string, string>): CallerCheck {
  const entries = Object.entries(tokenSha256ByCaller ?? {});
  if (entries.length === 0) throw new Error('bearerCallers: at least one caller is required');
  const seen = new Set<string>();
  const callers = entries.map(([caller, hex]) => {
    if (!CALLER_RE.test(caller)) throw new Error(`bearerCallers: caller "${caller}" is not of the form ${CALLER_RE}`);
    if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`bearerCallers: ${caller}'s token hash is not 64 lowercase hex characters`);
    if (seen.has(hex)) throw new Error(`bearerCallers: ${caller} shares a token with another caller`);
    seen.add(hex);
    return { caller, digest: Buffer.from(hex, 'hex') };
  });
  return {
    mode: 'bearer',
    check: (r) => {
      const m = /^Bearer (\S+)$/.exec(r.headers.get('authorization') ?? '');
      if (!m || !TOKEN_RE.test(m[1]!)) return { ok: false, reason: 'no bearer token, or one outside its form' };
      const digest = sha256(m[1]!);
      // Compare against every caller, so the time taken doesn't say which one matched.
      let found: string | null = null;
      for (const c of callers) if (timingSafeEqual(c.digest, digest)) found = c.caller;
      return found === null ? { ok: false, reason: 'the bearer token is not a configured caller' } : { ok: true, caller: found, callerName: found };
    },
  };
}
