// A strict verifier for OpenSSH's SSHSIG format (PROTOCOL.sshsig), ssh-ed25519 + sha512 only.
// agentKeyCallers (agent-key.ts) checks each request's signature with it against the caller's
// listed key. Moved here from W-1416's held door, so the library holds the one copy. It only
// VERIFIES, with node:crypto's Ed25519; signing is `ssh-keygen -Y sign` on the caller's side.
//
// Strictness is the point: every field is checked, nothing trailing is tolerated, and the
// namespace must equal the caller's exactly. The key embedded in a signature only FINDS what to
// verify against (signerBlob); the signature is verified against the listed key.
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';

export const SSHSIG_MAGIC = 'SSHSIG';
export const SSHSIG_HASH = 'sha512';
const ED25519 = 'ssh-ed25519';
/** A whole binary SSHSIG for ssh-ed25519 is 4+…: far under this; bigger is refused unread. */
export const SSHSIG_MAX_BYTES = 512;

/** Why a signature was refused. `bad_sig` = the signature itself failed;
    `unknown_key` = it was made by a key other than the enrolled one;
    everything else is a malformed blob. */
export type SshsigRefusal = 'malformed' | 'namespace' | 'hash' | 'unknown_key' | 'bad_sig';
export type SshsigVerdict = { ok: true } | { ok: false; cls: SshsigRefusal };

class Reader {
  private o = 0;
  constructor(private readonly b: Buffer) {}
  u32(): number {
    if (this.o + 4 > this.b.length) throw new Error('short');
    const v = this.b.readUInt32BE(this.o);
    this.o += 4;
    return v;
  }
  str(): Buffer {
    const n = this.u32();
    if (n > this.b.length - this.o) throw new Error('short');
    const s = this.b.subarray(this.o, this.o + n);
    this.o += n;
    return s;
  }
  raw(n: number): Buffer {
    if (this.o + n > this.b.length) throw new Error('short');
    const s = this.b.subarray(this.o, this.o + n);
    this.o += n;
    return s;
  }
  done(): boolean {
    return this.o === this.b.length;
  }
}

const sshString = (v: Buffer | string): Buffer => {
  const b = typeof v === 'string' ? Buffer.from(v, 'utf8') : v;
  const len = Buffer.alloc(4);
  len.writeUInt32BE(b.length);
  return Buffer.concat([len, b]);
};

/** The 32-byte Ed25519 key inside an ssh-ed25519 public key blob, or null. */
export function ed25519FromBlob(blob: Buffer): Buffer | null {
  try {
    const r = new Reader(blob);
    if (r.str().toString('utf8') !== ED25519) return null;
    const pk = r.str();
    return pk.length === 32 && r.done() ? Buffer.from(pk) : null;
  } catch {
    return null;
  }
}

/** The blob from an authorized_keys-style line (`ssh-ed25519 AAAA… [comment]`), or null. */
export function blobFromPublicKeyLine(line: string): Buffer | null {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 2 || parts[0] !== ED25519 || !/^[A-Za-z0-9+/]+={0,2}$/.test(parts[1]!)) return null;
  const blob = Buffer.from(parts[1]!, 'base64');
  return ed25519FromBlob(blob) === null ? null : blob;
}

/** ssh-keygen's fingerprint form: `SHA256:` + unpadded base64 of sha256(blob). */
export function fingerprintOf(blob: Buffer): string {
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}

function keyObject(pk: Buffer): KeyObject {
  // RFC 8410 SubjectPublicKeyInfo prefix for Ed25519.
  return createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pk]),
    format: 'der',
    type: 'spki',
  });
}

/**
 * Verify a binary SSHSIG over `message` under exactly `namespace`, made by the
 * key whose blob is `enrolledBlob`. Never throws.
 */
export function verifySshsig(sig: Buffer, message: Buffer, namespace: string, enrolledBlob: Buffer): SshsigVerdict {
  if (sig.length > SSHSIG_MAX_BYTES) return { ok: false, cls: 'malformed' };
  let pub: Buffer, ns: string, reserved: Buffer, hashAlg: string, inner: Buffer;
  try {
    const r = new Reader(sig);
    if (r.raw(6).toString('latin1') !== SSHSIG_MAGIC) return { ok: false, cls: 'malformed' };
    if (r.u32() !== 1) return { ok: false, cls: 'malformed' };
    pub = r.str();
    ns = r.str().toString('utf8');
    reserved = r.str();
    hashAlg = r.str().toString('utf8');
    inner = r.str();
    if (!r.done()) return { ok: false, cls: 'malformed' };
  } catch {
    return { ok: false, cls: 'malformed' };
  }
  if (reserved.length !== 0) return { ok: false, cls: 'malformed' };
  if (ns !== namespace) return { ok: false, cls: 'namespace' };
  if (hashAlg !== SSHSIG_HASH) return { ok: false, cls: 'hash' };
  if (ed25519FromBlob(pub) === null) return { ok: false, cls: 'malformed' };
  if (!pub.equals(enrolledBlob)) return { ok: false, cls: 'unknown_key' };
  let raw: Buffer;
  try {
    const r = new Reader(inner);
    if (r.str().toString('utf8') !== ED25519) return { ok: false, cls: 'malformed' };
    raw = r.str();
    if (raw.length !== 64 || !r.done()) return { ok: false, cls: 'malformed' };
  } catch {
    return { ok: false, cls: 'malformed' };
  }
  // PROTOCOL.sshsig: the signed data is a fixed preamble plus the HASH of the message.
  const signed = Buffer.concat([
    Buffer.from(SSHSIG_MAGIC, 'latin1'),
    sshString(namespace),
    sshString(''),
    sshString(SSHSIG_HASH),
    sshString(createHash('sha512').update(message).digest()),
  ]);
  try {
    return verify(null, signed, keyObject(ed25519FromBlob(enrolledBlob)!), raw) ? { ok: true } : { ok: false, cls: 'bad_sig' };
  } catch {
    return { ok: false, cls: 'bad_sig' };
  }
}

/** The public key blob a binary SSHSIG says made it (not verified: it only FINDS the key to verify with), or null. */
export function signerBlob(sig: Buffer): Buffer | null {
  if (sig.length > SSHSIG_MAX_BYTES) return null;
  try {
    const r = new Reader(sig);
    if (r.raw(6).toString('latin1') !== SSHSIG_MAGIC || r.u32() !== 1) return null;
    const pub = r.str();
    return ed25519FromBlob(pub) === null ? null : Buffer.from(pub);
  } catch {
    return null;
  }
}
