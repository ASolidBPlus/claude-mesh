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
 * Timing-safe string comparison.
 * Returns false immediately if lengths differ (length is not secret for fixed-length hashes).
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Validate a raw bearer token against a stored hash.
 */
export function validateToken(rawToken: string, storedHash: string): boolean {
  return timingSafeEqual(hashToken(rawToken), storedHash);
}
