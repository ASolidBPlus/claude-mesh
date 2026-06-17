/**
 * Parse a human duration string into milliseconds.
 * Accepted formats: "90s", "2m", "1h", "3d"
 * Returns null for invalid input or zero duration.
 */
export function parseDuration(input: string): number | null {
  if (typeof input !== 'string') return null;
  const m = input.match(/^(\d+)(s|m|h|d)$/);
  if (!m) return null;

  const value = Number(m[1]);
  if (!Number.isSafeInteger(value) || value === 0) return null;

  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };

  return value * multipliers[m[2]];
}
