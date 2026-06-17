// ──────────────────────────────────────────────
// 5-field POSIX cron parsing & next-occurrence computation.
//
// IMPORTANT: all cron times are interpreted in UTC. Every date access below
// uses UTC accessors (Date.UTC, getUTC*, setUTC*) — never local-time methods —
// so behaviour is identical regardless of the host container's TZ.
// ──────────────────────────────────────────────

interface FieldRange {
  min: number;
  max: number;
}

const FIELD_RANGES: FieldRange[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day-of-month
  { min: 1, max: 12 }, // month
  { min: 0, max: 6 },  // day-of-week (0=Sun, 7 is NOT an alias)
];

interface ParsedField {
  values: Set<number>;
  unrestricted: boolean; // true iff the raw field token was "*"
}

interface ParsedCron {
  minutes: ParsedField;
  hours: ParsedField;
  doms: ParsedField;
  months: ParsedField;
  dows: ParsedField;
}

/**
 * Parse a single cron field token into the set of values it matches.
 * Returns null if the token is malformed or out of range.
 * Supports: *, N, N-M, *\/N, N-M/N, comma-separated lists.
 */
function parseField(token: string, range: FieldRange): ParsedField | null {
  if (token.length === 0) return null;

  const unrestricted = token === '*';
  const values = new Set<number>();

  for (const part of token.split(',')) {
    if (part.length === 0) return null;

    // Split optional step: "<base>/<step>"
    let base = part;
    let step = 1;
    const slashIdx = part.indexOf('/');
    if (slashIdx !== -1) {
      base = part.slice(0, slashIdx);
      const stepStr = part.slice(slashIdx + 1);
      if (!/^\d+$/.test(stepStr)) return null;
      step = Number(stepStr);
      if (step === 0) return null; // reject */0
    }

    let lo: number;
    let hi: number;

    if (base === '*') {
      lo = range.min;
      hi = range.max;
    } else if (/^\d+$/.test(base)) {
      lo = Number(base);
      // A bare number with a step (e.g. "5/10") means "5, 15, 25, ..." up to max.
      hi = slashIdx !== -1 ? range.max : lo;
    } else {
      const rangeMatch = base.match(/^(\d+)-(\d+)$/);
      if (!rangeMatch) return null;
      lo = Number(rangeMatch[1]);
      hi = Number(rangeMatch[2]);
      if (lo > hi) return null; // reject inverted range (e.g. 5-1)
    }

    if (lo < range.min || lo > range.max || hi < range.min || hi > range.max) {
      return null;
    }

    for (let v = lo; v <= hi; v += step) {
      values.add(v);
    }
  }

  if (values.size === 0) return null;
  return { values, unrestricted };
}

function parseCron(expression: string): ParsedCron | null {
  if (typeof expression !== 'string') return null;
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;

  const minutes = parseField(fields[0], FIELD_RANGES[0]);
  const hours = parseField(fields[1], FIELD_RANGES[1]);
  const doms = parseField(fields[2], FIELD_RANGES[2]);
  const months = parseField(fields[3], FIELD_RANGES[3]);
  const dows = parseField(fields[4], FIELD_RANGES[4]);

  if (!minutes || !hours || !doms || !months || !dows) return null;

  return { minutes, hours, doms, months, dows };
}

/**
 * Validate a 5-field POSIX cron expression.
 * Fields: minute(0-59) hour(0-23) dom(1-31) month(1-12) dow(0-6, 0=Sun).
 * Supports: *, specific values, ranges (1-5), steps (*\/5, 1-10/2),
 * comma-separated lists (1,3,5). Strictly rejects out-of-range values,
 * zero steps (*\/0), and inverted ranges (5-1).
 *
 * All cron times are interpreted in UTC.
 */
export function cronValidate(expression: string): boolean {
  return parseCron(expression) !== null;
}

/**
 * POSIX dom/dow OR-semantics day match, evaluated against UTC accessors.
 */
function dayMatches(parsed: ParsedCron, date: Date): boolean {
  const domRestricted = !parsed.doms.unrestricted;
  const dowRestricted = !parsed.dows.unrestricted;

  if (!domRestricted && !dowRestricted) return true;
  if (domRestricted && !dowRestricted) return parsed.doms.values.has(date.getUTCDate());
  if (!domRestricted && dowRestricted) return parsed.dows.values.has(date.getUTCDay());
  // Both restricted → OR semantics: fire if either matches.
  return parsed.doms.values.has(date.getUTCDate()) || parsed.dows.values.has(date.getUTCDay());
}

/**
 * Compute the next occurrence of a cron schedule strictly AFTER the given
 * timestamp. Returns unix ms, or null if no occurrence is found within 366 days.
 *
 * All cron times are interpreted in UTC.
 */
export function cronNext(expression: string, after: number): number | null {
  const parsed = parseCron(expression);
  if (parsed === null) return null;

  // ── all candidate stepping below is performed in UTC ──
  // Start at the next whole minute strictly after `after`. When `after` is
  // already on a minute boundary this adds a full 60000ms, advancing to the
  // next minute (strictly-after contract).
  let candidateMs = after + (60_000 - (after % 60_000));
  const cap = after + 366 * 86_400_000;

  while (candidateMs <= cap) {
    const d = new Date(candidateMs);

    // Month check: jump to 00:00 on the 1st of the next month (UTC) via
    // Date.UTC overflow normalization so December rolls into the next year.
    if (!parsed.months.values.has(d.getUTCMonth() + 1)) {
      candidateMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0, 0);
      continue;
    }

    // Day check (POSIX dom/dow OR rule): jump to 00:00 of the next UTC day.
    if (!dayMatches(parsed, d)) {
      candidateMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
      continue;
    }

    // Hour check: jump to :00 of the next hour (UTC).
    if (!parsed.hours.values.has(d.getUTCHours())) {
      candidateMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + 1, 0, 0, 0);
      continue;
    }

    // Minute check: advance to the next minute (UTC).
    if (!parsed.minutes.values.has(d.getUTCMinutes())) {
      candidateMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes() + 1, 0, 0);
      continue;
    }

    // All fields match.
    return candidateMs;
  }

  return null;
}
