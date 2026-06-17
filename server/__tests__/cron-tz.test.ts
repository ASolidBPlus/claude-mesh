import { describe, it, expect } from 'bun:test';
import { tzValidate, cronNextTz, cronNext, wallTimeToUtc } from '../cron.ts';

describe('cron-tz: tzValidate', () => {
  it('test 7: valid IANA zone', () => {
    expect(tzValidate('Australia/Adelaide')).toBe(true);
  });
  it('test 8: UTC', () => {
    expect(tzValidate('UTC')).toBe(true);
  });
  it('test 9: bogus zone', () => {
    expect(tzValidate('Not/AZone')).toBe(false);
  });
  it('test 10: empty string', () => {
    expect(tzValidate('')).toBe(false);
  });
});

describe('cron-tz: cronNextTz DST', () => {
  it('test 11: DST BEFORE (ACST +9:30) → Sun 2026-09-27 23:30 UTC', () => {
    const ref = Date.UTC(2026, 8, 21, 0, 0, 0);
    const got = cronNextTz('0 9 * * 1', ref, 'Australia/Adelaide');
    expect(got).toBe(Date.UTC(2026, 8, 27, 23, 30, 0));
  });

  it('test 12: DST AFTER (ACDT +10:30) → Sun 2026-10-04 22:30 UTC', () => {
    const ref = Date.UTC(2026, 9, 4, 12, 0, 0);
    const got = cronNextTz('0 9 * * 1', ref, 'Australia/Adelaide');
    expect(got).toBe(Date.UTC(2026, 9, 4, 22, 30, 0));
  });

  it('test 13: tz "UTC" == plain cronNext for several refs', () => {
    const refs = [
      Date.UTC(2026, 0, 1, 0, 0, 0),
      Date.UTC(2026, 5, 15, 3, 4, 0),
      Date.UTC(2026, 11, 31, 23, 59, 0),
      Date.now(),
    ];
    for (const ref of refs) {
      expect(cronNextTz('0 9 * * 1', ref, 'UTC')).toBe(cronNext('0 9 * * 1', ref));
    }
  });

  it('test 14: invalid tz → null', () => {
    expect(cronNextTz('0 9 * * 1', Date.now(), 'Bogus/Zone')).toBe(null);
  });

  it('test 15: invalid cron → null', () => {
    expect(cronNextTz('nonsense', Date.now(), 'Australia/Adelaide')).toBe(null);
  });

  it('test 16: same-day firing in tz (no week-skip)', () => {
    // REF = Mon 2026-09-28 06:00 ACST = 2026-09-27 20:30 UTC
    const ref = Date.UTC(2026, 8, 27, 20, 30, 0);
    const got = cronNextTz('0 9 * * 1', ref, 'Australia/Adelaide');
    expect(got).toBe(Date.UTC(2026, 8, 27, 23, 30, 0));
    expect(got!).toBeGreaterThan(ref);
  });

  it('test 17: spring-forward gap monotonic', () => {
    // REF just before Oct 4 2026 02:30 (non-existent wall time, 02:00→03:00).
    const ref = Date.UTC(2026, 9, 3, 12, 0, 0);
    const got = cronNextTz('30 2 * * *', ref, 'Australia/Adelaide');
    expect(got).not.toBe(null);
    expect(got!).toBeGreaterThan(ref);
    // Reads back in Adelaide as wall hour 03 (gap rolled forward).
    const wall = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Australia/Adelaide', hour12: false, hour: '2-digit',
    }).formatToParts(new Date(got!)).find(p => p.type === 'hour')!.value;
    expect(parseInt(wall, 10) % 24).toBe(3);
    // A second call with after=result advances to the next day.
    const next = cronNextTz('30 2 * * *', got!, 'Australia/Adelaide');
    expect(next!).toBeGreaterThan(got!);
  });
});
