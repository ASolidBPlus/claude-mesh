import * as crypto from 'crypto';

/**
 * Generate a cryptographically random 64-hex-char bearer token (256 bits of entropy).
 */
export function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Compute SHA-256(token) and return it as a lowercase hex string.
 */
export function hashToken(token: string): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(token);
  return hasher.digest('hex');
}

/**
 * Timing-safe string comparison. THE one comparison used for every secret in
 * this server — admin tokens, agent tokens, peer-key secrets.
 *
 * WHY NOT THE HAND-ROLLED LOOP THIS REPLACES. The previous version early-returned
 * on a length mismatch and then ran a `charCodeAt`/XOR loop. It did not throw,
 * which was the important part, but it was constant-time only ACROSS EQUAL-LENGTH
 * INPUTS, and a JIT-compiled character loop is best-effort by nature — the engine
 * is free to optimise it in ways that reintroduce data-dependent timing. It
 * claimed slightly more than it delivered.
 *
 * WHY THE PREPAD. `crypto.timingSafeEqual` THROWS on unequal lengths, which is
 * unusable directly for a comparison whose whole job is not to branch on the
 * input. Padding both sides to the same length makes the compare run in full
 * regardless, and the length equality is then folded in as a separate, non-secret
 * term — token formats here are public, so length was never the secret.
 *
 * The construction is claude-spawner's, deliberately: one behaviour, already
 * reviewed, rather than a fourth variant invented here.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  const width = Math.max(ab.length, bb.length, 1);
  const pa = Buffer.alloc(width);
  const pb = Buffer.alloc(width);
  ab.copy(pa);
  bb.copy(pb);
  // The padded compare runs first and always, so it is the timing-relevant term;
  // the length check that follows is O(1) and decides only what padding hid.
  const sameBytes = crypto.timingSafeEqual(pa, pb);
  return sameBytes && ab.length === bb.length;
}

/**
 * Validate a raw bearer token against a stored hash.
 */
export function validateToken(rawToken: string, storedHash: string): boolean {
  return timingSafeEqual(hashToken(rawToken), storedHash);
}
