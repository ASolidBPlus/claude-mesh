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
 * POSIX dom/dow OR-semantics day match, evaluated against bare calendar fields.
 * `dom` is day-of-month (1-31), `dow` is day-of-week (0=Sun..6=Sat).
 */
function dayMatchesFields(parsed: ParsedCron, dom: number, dow: number): boolean {
  const domRestricted = !parsed.doms.unrestricted;
  const dowRestricted = !parsed.dows.unrestricted;

  if (!domRestricted && !dowRestricted) return true;
  if (domRestricted && !dowRestricted) return parsed.doms.values.has(dom);
  if (!domRestricted && dowRestricted) return parsed.dows.values.has(dow);
  // Both restricted → OR semantics: fire if either matches.
  return parsed.doms.values.has(dom) || parsed.dows.values.has(dow);
}

/**
 * POSIX dom/dow OR-semantics day match, evaluated against UTC accessors.
 * Delegates to dayMatchesFields so the UTC path stays behaviourally identical.
 */
function dayMatches(parsed: ParsedCron, date: Date): boolean {
  return dayMatchesFields(parsed, date.getUTCDate(), date.getUTCDay());
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

// ──────────────────────────────────────────────
// Timezone-aware cron (Sprint 15). Zero new deps — built-in Intl only.
//
// `tz = null` reminders never reach here; they use the UTC cronNext above and
// remain byte-for-byte unchanged. These helpers are used only when a reminder
// carries an explicit IANA tz.
// ──────────────────────────────────────────────

/**
 * Validate an IANA timezone string (e.g. "Australia/Adelaide", "UTC").
 * Returns true iff Intl accepts it as a timeZone. Empty/non-string → false.
 */
export function tzValidate(tz: string): boolean {
  if (typeof tz !== 'string' || tz.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Return the offset (ms) such that:  wallClockFieldsAsIfUTC - actualUTC = offset
 * i.e. how far ahead of UTC the zone is at instant utcMs.
 */
function tzOffsetMs(utcMs: number, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const m: Record<string, string> = {};
  for (const p of parts) if (p.type !== 'literal') m[p.type] = p.value;
  let hour = parseInt(m.hour, 10);
  if (hour === 24) hour = 0; // Intl can emit "24" for midnight in some envs
  const asUTC = Date.UTC(
    Number(m.year), Number(m.month) - 1, Number(m.day),
    hour, Number(m.minute), Number(m.second),
  );
  return asUTC - utcMs;
}

/**
 * Given calendar wall-clock fields (y, mo[0-11], d, h, mi) meant to be read IN
 * zone `tz`, return the UTC ms instant. Standard 2-pass offset-convergence:
 * guess UTC = fields-as-if-UTC, measure offset at that guess, correct, then
 * re-measure once so a DST boundary between guess and corrected instant is
 * accounted for. Converges for all standard 30/60-minute transitions.
 */
export function wallTimeToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const naiveUTC = Date.UTC(y, mo, d, h, mi, 0);
  const off = tzOffsetMs(naiveUTC, tz);
  let utc = naiveUTC - off;
  const off2 = tzOffsetMs(utc, tz);
  if (off2 !== off) utc = naiveUTC - off2;
  return utc;
}

/**
 * True iff `s` is a "bare" (zone-less) ISO-8601 date-time: a calendar
 * date+time with NO zone designator (no trailing "Z", no ±HH:MM offset).
 * Such a value is interpreted as WALL-CLOCK time in the caller's `tz`.
 * Anything WITH a Z/offset is an absolute instant — tz is a no-op for it.
 * Durations ("90s", "2h") are not ISO date-times → return false here too.
 */
export function isBareIso(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s);
}

/**
 * Parse a bare offset-less ISO date-time string and interpret its calendar
 * fields as WALL-CLOCK time in zone `tz`, returning the UTC ms instant.
 * Caller must have already verified `isBareIso(s)`.
 */
export function bareIsoToUtc(s: string, tz: string): number {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m === null) return NaN;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const h = Number(m[4]);
  const mi = Number(m[5]);
  // seconds are dropped — cron/reminder granularity is per-minute
  return wallTimeToUtc(y, mo, d, h, mi, tz);
}

/**
 * Compute the next occurrence of a 5-field cron expression strictly AFTER
 * `after` (unix ms), where the cron fields are interpreted as WALL-CLOCK time
 * in IANA zone `tz`. Returns the UTC ms instant, or null if no occurrence is
 * found within 366 days, or null if `tz`/`expression` is invalid.
 *
 * DST handling:
 *  - Spring-forward gap (a wall-clock time that does not exist): the computed
 *    instant rolls forward to the next valid instant.
 *  - Fall-back overlap (a wall-clock time that occurs twice): the 2-pass
 *    offset-convergence resolves to the STANDARD-time (second) occurrence.
 *    Deterministic and fires exactly once; NOT the first occurrence.
 */
export function cronNextTz(expression: string, after: number, tz: string): number | null {
  if (!tzValidate(tz)) return null;
  const parsed = parseCron(expression);
  if (parsed === null) return null;

  const cap = after + 366 * 86_400_000;

  // Read `after`'s wall-clock fields in `tz`.
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const sp: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(after))) if (p.type !== 'literal') sp[p.type] = p.value;
  let sh = parseInt(sp.hour, 10);
  if (sh === 24) sh = 0;

  // Calendar tuple in wall-clock space; advance to the next whole minute
  // strictly after `after` (drop seconds, add one minute).
  let y = Number(sp.year);
  let mo = Number(sp.month) - 1; // 0-11
  let d = Number(sp.day);
  let h = sh;
  let mi = Number(sp.minute) + 1;

  // Normalize the initial tuple via a throwaway UTC Date (pure calendar
  // arithmetic — NOT a tz conversion).
  const norm = () => {
    const nd = new Date(Date.UTC(y, mo, d, h, mi, 0));
    y = nd.getUTCFullYear();
    mo = nd.getUTCMonth();
    d = nd.getUTCDate();
    h = nd.getUTCHours();
    mi = nd.getUTCMinutes();
    return nd.getUTCDay();
  };

  let dow = norm();

  // Safeguard cap on iterations in wall-minute space.
  const maxIters = 366 * 24 * 60 + 1500;
  for (let i = 0; i < maxIters; i++) {
    if (!parsed.months.values.has(mo + 1)) {
      mo = mo + 1; d = 1; h = 0; mi = 0;
      dow = norm();
      continue;
    }
    if (!dayMatchesFields(parsed, d, dow)) {
      d = d + 1; h = 0; mi = 0;
      dow = norm();
      continue;
    }
    if (!parsed.hours.values.has(h)) {
      h = h + 1; mi = 0;
      dow = norm();
      continue;
    }
    if (!parsed.minutes.values.has(mi)) {
      mi = mi + 1;
      dow = norm();
      continue;
    }
    // All wall fields match → convert to the UTC instant.
    const utc = wallTimeToUtc(y, mo, d, h, mi, tz);
    if (utc > cap) return null;
    return utc;
  }

  return null;
}
