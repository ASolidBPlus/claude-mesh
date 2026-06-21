import { describe, it, expect } from 'bun:test';
import { cronValidate, cronNext } from '../cron.ts';

describe('cronValidate', () => {
  it('accepts * * * * *', () => { expect(cronValidate('* * * * *')).toBe(true); });
  it('accepts */5 * * * *', () => { expect(cronValidate('*/5 * * * *')).toBe(true); });
  it('accepts 0 12 * * 1-5', () => { expect(cronValidate('0 12 * * 1-5')).toBe(true); });
  it('accepts 0,30 * * * *', () => { expect(cronValidate('0,30 * * * *')).toBe(true); });
  it('rejects "invalid"', () => { expect(cronValidate('invalid')).toBe(false); });
  it('rejects out-of-range minute 60', () => { expect(cronValidate('60 * * * *')).toBe(false); });
  it('rejects 6-field expression', () => { expect(cronValidate('* * * * * *')).toBe(false); });
  it('accepts weekly 0 9 * * 1', () => { expect(cronValidate('0 9 * * 1')).toBe(true); });
  it('rejects dow=7 (not a Sunday alias)', () => { expect(cronValidate('0 9 * * 7')).toBe(false); });

  // Extra defensive cases (DIRECTIVE 4b)
  it('rejects zero step */0', () => { expect(cronValidate('*/0 * * * *')).toBe(false); });
  it('rejects inverted range 5-1', () => { expect(cronValidate('5-1 * * * *')).toBe(false); });
  it('rejects out-of-range hour 24', () => { expect(cronValidate('0 24 * * *')).toBe(false); });
  it('rejects dom 0', () => { expect(cronValidate('0 0 0 * *')).toBe(false); });
  it('rejects month 13', () => { expect(cronValidate('0 0 1 13 *')).toBe(false); });
});

describe('cronNext', () => {
  it('next minute boundary after ts (* * * * *)', () => {
    const ref = Date.UTC(2026, 5, 17, 14, 30, 15); // 14:30:15
    const next = cronNext('* * * * *', ref);
    expect(next).toBe(Date.UTC(2026, 5, 17, 14, 31, 0));
  });

  it('strictly-after on a minute boundary advances to next minute', () => {
    const ref = Date.UTC(2026, 5, 17, 14, 30, 0); // exact boundary
    const next = cronNext('* * * * *', ref);
    expect(next).toBe(Date.UTC(2026, 5, 17, 14, 31, 0));
  });

  it('next hour boundary (0 * * * *)', () => {
    const ref = Date.UTC(2026, 5, 17, 14, 30, 0);
    const next = cronNext('0 * * * *', ref);
    expect(next).toBe(Date.UTC(2026, 5, 17, 15, 0, 0));
  });

  it('next 12:30 UTC (30 12 * * *)', () => {
    const ref = Date.UTC(2026, 5, 17, 14, 30, 0); // after 12:30 today
    const next = cronNext('30 12 * * *', ref);
    expect(next).toBe(Date.UTC(2026, 5, 18, 12, 30, 0));
  });

  it('next Jan 1 00:00 UTC (0 0 1 1 *) rolls into next year', () => {
    const ref = Date.UTC(2026, 5, 17, 0, 0, 0);
    const next = cronNext('0 0 1 1 *', ref);
    expect(next).toBe(Date.UTC(2027, 0, 1, 0, 0, 0));
  });

  it('next 5-min boundary (*/5 * * * *)', () => {
    const ref = Date.UTC(2026, 5, 17, 14, 32, 0);
    const next = cronNext('*/5 * * * *', ref);
    expect(next).toBe(Date.UTC(2026, 5, 17, 14, 35, 0));
  });

  it('weekly next-due: first Monday 09:00 UTC strictly after REF', () => {
    const REF = Date.UTC(2026, 5, 17, 14, 30, 0); // Wed 2026-06-17 14:30 UTC
    const next = cronNext('0 9 * * 1', REF)!;
    expect(next).toBe(Date.UTC(2026, 5, 22, 9, 0, 0)); // Mon 2026-06-22 09:00 UTC
    const d = new Date(next);
    expect(d.getUTCDay()).toBe(1);
    expect(d.getUTCHours()).toBe(9);
    expect(d.getUTCMinutes()).toBe(0);
    expect(d.getUTCSeconds()).toBe(0);
  });

  it('same-day edge: Monday 08:00 ref does NOT skip a week', () => {
    const REF = Date.UTC(2026, 5, 22, 8, 0, 0); // Mon 2026-06-22 08:00 UTC
    const next = cronNext('0 9 * * 1', REF);
    expect(next).toBe(Date.UTC(2026, 5, 22, 9, 0, 0)); // SAME Monday 09:00
  });

  it('dom/dow OR-semantics: 0 0 1 * 1 fires on next Monday before next 1st', () => {
    const REF = Date.UTC(2026, 5, 17, 0, 0, 0); // Wed 2026-06-17 00:00 UTC
    const next = cronNext('0 0 1 * 1', REF);
    expect(next).toBe(Date.UTC(2026, 5, 22, 0, 0, 0)); // Mon 2026-06-22 (dow side)
  });
});
