import { describe, expect, it } from 'vitest';
import { compareLevel, compareMonthly, fullMonthSums } from '../../src/ingest/crosscheck.js';
import { addDays } from '../../src/ingest/time.js';
import type { DailyPoint } from '../../src/ingest/types.js';

/** `count` consecutive days starting at `first`, each with `value`. */
const days = (first: string, count: number, value: number): DailyPoint[] =>
  Array.from({ length: count }, (_, i) => ({ day: addDays(first, i), value }));

describe('compareLevel', () => {
  it('is fine exactly at the tolerance and a mismatch just beyond it', () => {
    expect(compareLevel(100, 102, 2)).toEqual({ diffPct: 2, ok: true });
    expect(compareLevel(100, 97.99, 2).ok).toBe(false);
    expect(compareLevel(100, 100, 0)).toEqual({ diffPct: 0, ok: true });
  });
  it('measures against the absolute primary value', () => {
    expect(compareLevel(-50, -55, 5).diffPct).toBeCloseTo(10, 12);
  });
  it('reports 100 percent when the primary is zero and the check is not', () => {
    expect(compareLevel(0, 0, 1)).toEqual({ diffPct: 0, ok: true });
    expect(compareLevel(0, 3, 1)).toEqual({ diffPct: 100, ok: false });
  });
});

describe('fullMonthSums', () => {
  it('sums only months in which every day is present', () => {
    const points = [...days('2026-06-21', 10, 1), ...days('2026-07-01', 31, 2), ...days('2026-08-01', 30, 3)]; // August lacks the 31st
    expect([...fullMonthSums(points)]).toEqual([['2026-07', 62]]);
  });
  it('counts a day once even if it appears twice', () => {
    const points = [...days('2026-02-01', 28, 1), { day: '2026-02-10', value: 1 }];
    expect(fullMonthSums(points).get('2026-02')).toBe(29); // summed, but the month still needs 28 distinct days
    expect(fullMonthSums([...days('2026-02-01', 27, 1), { day: '2026-02-10', value: 1 }]).size).toBe(0);
  });
});

describe('compareMonthly', () => {
  const primary = [...days('2026-06-21', 10, 100), ...days('2026-07-01', 31, 100), ...days('2026-08-01', 31, 100), ...days('2026-09-01', 18, 100)];

  it('compares only months fully covered by both daily series', () => {
    const check = { kind: 'daily_series' as const, detail: 'x', points: [...days('2026-07-01', 31, 103), ...days('2026-08-01', 31, 110), ...days('2026-09-01', 19, 100)] };
    const out = compareMonthly(primary, check, 5, '2026-09');
    expect(out.map((m) => m.month)).toEqual(['2026-07', '2026-08']);
    expect(out[0]).toMatchObject({ primary: 3100, check: 3193, ok: true });
    expect(out[0].diffPct).toBeCloseTo(3, 9);
    expect(out[1]).toMatchObject({ ok: false });
    expect(out[1].diffPct).toBeCloseTo(10, 9);
  });

  it('treats a monthly series as complete only for months before the current one', () => {
    const check = {
      kind: 'monthly_series' as const, detail: 'x',
      points: [{ month: '2026-06', value: 1 }, { month: '2026-07', value: 3100 }, { month: '2026-08', value: 3100.5 }, { month: '2026-09', value: 1800 }],
    };
    const out = compareMonthly(primary, check, 0.1, '2026-09');
    expect(out.map((m) => [m.month, m.ok])).toEqual([['2026-07', true], ['2026-08', true]]); // June is partial on-chain, September is running
  });

  it('returns nothing when no month is covered by both', () => {
    expect(compareMonthly(days('2026-09-01', 10, 1), { kind: 'daily_series', detail: 'x', points: days('2026-09-01', 10, 1) }, 5, '2026-09')).toEqual([]);
  });
});
