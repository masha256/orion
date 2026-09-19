import { describe, expect, it } from 'vitest';
import { EngineError } from '../../src/engine/errors.js';
import { captureRateAt, growthInYear, need, revenueAt } from '../../src/engine/paths.js';

const a = { rev_growth_y1: 1, growth_fade_years: 2, terminal_growth: 0 };

describe('revenue path', () => {
  it('fades growth linearly to terminal', () => {
    expect(growthInYear(1, a)).toBe(1);
    expect(growthInYear(2, a)).toBe(0.5);
    expect(growthInYear(3, a)).toBe(0);
    expect(growthInYear(9, a)).toBe(0);
  });
  it('compounds whole and fractional years', () => {
    expect(revenueAt(0, 100, a)).toBe(100);
    expect(revenueAt(0.5, 100, a)).toBeCloseTo(100 * Math.SQRT2, 9);
    expect(revenueAt(1, 100, a)).toBeCloseTo(200, 9);
    expect(revenueAt(2, 100, a)).toBeCloseTo(300, 9);
    expect(revenueAt(3, 100, a)).toBeCloseTo(300, 9);
  });
  it('jumps straight to terminal growth when fade is zero', () => {
    expect(growthInYear(2, { ...a, growth_fade_years: 0 })).toBe(0);
  });
});

describe('captureRateAt', () => {
  it('ramps linearly and then holds', () => {
    expect(captureRateAt(0, 0.1, 0.3, 2)).toBeCloseTo(0.1, 12);
    expect(captureRateAt(1, 0.1, 0.3, 2)).toBeCloseTo(0.2, 12);
    expect(captureRateAt(5, 0.1, 0.3, 2)).toBeCloseTo(0.3, 12);
  });
  it('switches immediately when ramp is zero', () => {
    expect(captureRateAt(0, 0.1, 0.3, 0)).toBe(0.1);
    expect(captureRateAt(0.01, 0.1, 0.3, 0)).toBe(0.3);
  });
});

describe('need', () => {
  it('throws EngineError for a missing key', () => {
    expect(() => need({}, 'x')).toThrow(EngineError);
  });
});
