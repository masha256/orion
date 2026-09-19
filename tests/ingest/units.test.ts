import { describe, expect, it } from 'vitest';
import { addDays, dayStartMs, daysInMonth, monthOf, utcDay } from '../../src/ingest/time.js';
import { toFiniteNumber, unitsToNumber } from '../../src/ingest/units.js';

describe('unitsToNumber', () => {
  it('converts base units without losing the whole part to float rounding', () => {
    expect(unitsToNumber(114886562770481399543309743n, 18)).toBeCloseTo(114886562.7704814, 6);
    expect(unitsToNumber(200000000000000000n, 18)).toBe(0.2);
    expect(unitsToNumber(18n, 0)).toBe(18);
    expect(unitsToNumber(0n, 18)).toBe(0);
  });
});

describe('toFiniteNumber', () => {
  it('accepts numbers and numeric strings, including scientific notation', () => {
    expect(toFiniteNumber(26.03)).toBe(26.03);
    expect(toFiniteNumber('26.699999999999999289')).toBeCloseTo(26.7, 12);
    expect(toFiniteNumber('3.95e+22')).toBe(3.95e22);
  });
  it('rejects everything else', () => {
    for (const v of ['', '  ', 'abc', null, undefined, true, {}, [], NaN, Infinity, '1e999']) expect(toFiniteNumber(v)).toBeNull();
  });
});

describe('UTC day helpers', () => {
  it('round-trips days and crosses month and year ends', () => {
    expect(utcDay(Date.parse('2026-09-19T23:59:59.999Z'))).toBe('2026-09-19');
    expect(dayStartMs('2026-09-19')).toBe(Date.parse('2026-09-19T00:00:00.000Z'));
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(monthOf('2026-09-19')).toBe('2026-09');
    expect(daysInMonth('2026-02')).toBe(28);
    expect(daysInMonth('2028-02')).toBe(29);
    expect(daysInMonth('2026-09')).toBe(30);
  });
});
