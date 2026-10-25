// The vouch: how a system knows a call came through the bridge, and for whom. The bridge signs
// each call it forwards with its own Ed25519 key; the system pins the bridge's public keys and
// verifies. The signature binds what was vouched for (system, action, caller, body), not just a
// token, so a vouch for one call can't be replayed as another. The wire format is in
// docs/declare.md and pinned by test/fixtures/vouch-v1.json; the bridge signs with signVouch.
import { createHash, createPublicKey, randomBytes, sign, verify, type KeyObject } from 'node:crypto';

export const VOUCH_NAMESPACE = 'bridge-vouch-v1';
export const VOUCH_HEADER = 'x-bridge-vouch';
export const CALLER_HEADER = 'x-bridge-caller';
export const VOUCH_WINDOW_MS = 60_000;
/** The action slot of a declaration read: outside ACTION_RE, so it can never name a real action. */
export const DECLARATION_ACTION = '.declaration';

// Every field is checked against its form before it goes into the signed message, so none can
// carry a newline into it. `<system>__<action>` (the bridge's tool name) fits MCP's 64 characters.
export const SYSTEM_RE = /^[a-z][a-z0-9-]{0,23}$/;
export const ACTION_RE = /^[a-z][a-z0-9_]{0,37}$/;
export const CALLER_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const TS_RE = /^[0-9]{1,15}$/;
const HEADER_RE = /^v1\.([0-9]{1,15})\.([A-Za-z0-9_-]{16,64})\.([A-Za-z0-9+/]{86}==)$/;

export const isActionName = (name: string) => ACTION_RE.test(name) && !name.includes('__');

export interface VouchFields {
  system: string;
  action: string;
  caller: string;
  bodySha256: string;
  ts: number;
  nonce: string;
}

export const sha256Hex = (body: Uint8Array) => createHash('sha256').update(body).digest('hex');

/** The exact bytes the bridge signs. Throws on a field outside its form. */
export function vouchMessage(f: VouchFields): string {
  if (!SYSTEM_RE.test(f.system)) throw new Error(`vouch: system "${f.system}" is not of the form ${SYSTEM_RE}`);
  if (!isActionName(f.action) && f.action !== DECLARATION_ACTION) throw new Error(`vouch: action "${f.action}" is not an action name`);
  if (!CALLER_RE.test(f.caller)) throw new Error(`vouch: caller "${f.caller}" is not of the form ${CALLER_RE}`);
  if (!/^[0-9a-f]{64}$/.test(f.bodySha256)) throw new Error('vouch: bodySha256 is not 64 lowercase hex characters');
  if (!Number.isSafeInteger(f.ts) || f.ts < 0 || !TS_RE.test(String(f.ts))) throw new Error('vouch: ts is not unix milliseconds');
  if (!NONCE_RE.test(f.nonce)) throw new Error(`vouch: nonce is not of the form ${NONCE_RE}`);
  return [VOUCH_NAMESPACE, f.system, f.action, f.caller, f.bodySha256, String(f.ts), f.nonce].join('\n');
}

/** A bridge public key as systems pin it: the raw 32 bytes, base64url (the JWK `x`). */
export const bridgeKeyText = (publicKey: KeyObject): string => {
  const jwk = publicKey.export({ format: 'jwk' });
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') throw new Error('bridge key: not an Ed25519 public key');
  return jwk.x;
};

/** Reads a pinned bridge key back. Throws on anything but a 32-byte Ed25519 key. */
export function parseBridgeKey(text: string): KeyObject {
  if (!/^[A-Za-z0-9_-]{43}$/.test(text)) throw new Error('bridge key: not 32 bytes of base64url');
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: text }, format: 'jwk' });
}

/** The headers the bridge sends with a call. ts and nonce are fresh unless given (tests, golden). */
export function signVouch(
  privateKey: KeyObject,
  c: { system: string; action: string; caller: string; body: Uint8Array; ts?: number | undefined; nonce?: string | undefined },
): Record<string, string> {
  const ts = c.ts ?? Date.now();
  const nonce = c.nonce ?? randomBytes(16).toString('base64url');
  const msg = vouchMessage({ system: c.system, action: c.action, caller: c.caller, bodySha256: sha256Hex(c.body), ts, nonce });
  const sig = sign(null, Buffer.from(msg), privateKey).toString('base64');
  return { [VOUCH_HEADER]: `v1.${ts}.${nonce}.${sig}`, [CALLER_HEADER]: c.caller };
}

/**
 * Nonces seen inside the window. A nonce is recorded only after its signature verified, so only
 * the bridge can add entries; each is kept until its ts leaves the window, after which the ts
 * check refuses it anyway.
 */
export class NonceCache {
  private readonly seen = new Map<string, number>();
  /** True if the nonce is new (and records it); false if seen within the window. */
  claim(nonce: string, ts: number, nowMs: number): boolean {
    for (const [n, until] of this.seen) if (until < nowMs) this.seen.delete(n);
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, ts + VOUCH_WINDOW_MS);
    return true;
  }
}

export type VouchResult = { ok: true; caller: string } | { ok: false; reason: string };

/** Checks a call's vouch: its form, the window, the signature over this call, then the nonce. */
export function verifyVouch(v: {
  keys: KeyObject[];
  system: string;
  action: string;
  header: string | null;
  callerHeader: string | null;
  body: Uint8Array;
  nowMs: number;
  nonces: NonceCache;
  /** When the app started: a vouch from before it is refused, since the nonces seen before a restart are gone. */
  bootMs?: number | undefined;
}): VouchResult {
  if (v.header === null) return { ok: false, reason: 'no vouch header' };
  const m = HEADER_RE.exec(v.header);
  if (!m) return { ok: false, reason: 'the vouch header is not of the form v1.<ts>.<nonce>.<sig>' };
  const ts = Number(m[1]);
  const nonce = m[2]!;
  const caller = v.callerHeader;
  if (caller === null || !CALLER_RE.test(caller)) return { ok: false, reason: 'no caller, or a caller outside its form' };
  if (Math.abs(v.nowMs - ts) > VOUCH_WINDOW_MS) return { ok: false, reason: 'the vouch is outside the 60 s window' };
  if (v.bootMs !== undefined && ts < v.bootMs) return { ok: false, reason: 'the vouch is from before this app started' };
  let msg: string;
  try {
    msg = vouchMessage({ system: v.system, action: v.action, caller, bodySha256: sha256Hex(v.body), ts, nonce });
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  const sig = Buffer.from(m[3]!, 'base64');
  if (!v.keys.some((k) => verify(null, Buffer.from(msg), k, sig))) return { ok: false, reason: 'no pinned bridge key verifies the vouch' };
  if (!v.nonces.claim(nonce, ts, v.nowMs)) return { ok: false, reason: 'the nonce was already used' };
  return { ok: true, caller };
}
