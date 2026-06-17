import { describe, it, expect } from 'bun:test';
import { parseDuration } from '../duration.ts';

describe('parseDuration', () => {
  it('parses 90s', () => { expect(parseDuration('90s')).toBe(90000); });
  it('parses 2m', () => { expect(parseDuration('2m')).toBe(120000); });
  it('parses 1h', () => { expect(parseDuration('1h')).toBe(3600000); });
  it('parses 3d', () => { expect(parseDuration('3d')).toBe(259200000); });
  it('rejects zero duration 0s', () => { expect(parseDuration('0s')).toBe(null); });
  it('rejects non-numeric abc', () => { expect(parseDuration('abc')).toBe(null); });
  it('rejects empty string', () => { expect(parseDuration('')).toBe(null); });
  it('rejects unknown unit 10x', () => { expect(parseDuration('10x')).toBe(null); });
  it('rejects unitless 5', () => { expect(parseDuration('5')).toBe(null); });
});
