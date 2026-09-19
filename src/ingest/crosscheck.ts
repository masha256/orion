import { daysInMonth, monthOf } from './time.js';
import type { DailyPoint, SourceValue } from './types.js';

/** Pure comparisons between a primary reading and a cross-check reading. No I/O, no clock. */
export function compareLevel(primary: number, check: number, tolerancePct: number): { diffPct: number; ok: boolean } {
  const diffPct = primary === 0 ? (check === 0 ? 0 : 100) : (Math.abs(primary - check) / Math.abs(primary)) * 100;
  return { diffPct, ok: diffPct <= tolerancePct };
}

/** Month -> sum, for the months in which every calendar day has a point. */
export function fullMonthSums(points: DailyPoint[]): Map<string, number> {
  const seen = new Map<string, Set<string>>();
  const sums = new Map<string, number>();
  for (const p of points) {
    const month = monthOf(p.day);
    const set = seen.get(month) ?? new Set<string>();
    set.add(p.day);
    seen.set(month, set);
    sums.set(month, (sums.get(month) ?? 0) + p.value);
  }
  const full = new Map<string, number>();
  for (const month of [...sums.keys()].sort()) {
    if (seen.get(month)!.size === daysInMonth(month)) full.set(month, sums.get(month)!);
  }
  return full;
}

export interface MonthComparison {
  month: string;
  primary: number;
  check: number;
  diffPct: number;
  ok: boolean;
}

/**
 * Compares calendar months fully covered by both series, each month on its own. A monthly check
 * series counts as complete for months strictly before `currentMonth`.
 */
export function compareMonthly(
  primary: DailyPoint[],
  check: Extract<SourceValue, { kind: 'daily_series' | 'monthly_series' }>,
  tolerancePct: number,
  currentMonth: string,
): MonthComparison[] {
  const ours = fullMonthSums(primary);
  const theirs =
    check.kind === 'daily_series'
      ? fullMonthSums(check.points)
      : new Map(check.points.filter((p) => p.month < currentMonth).map((p) => [p.month, p.value] as const));
  const out: MonthComparison[] = [];
  for (const [month, value] of ours) {
    const other = theirs.get(month);
    if (other === undefined) continue;
    out.push({ month, primary: value, check: other, ...compareLevel(value, other, tolerancePct) });
  }
  return out;
}
