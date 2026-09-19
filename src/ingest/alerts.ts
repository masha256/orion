import { MS_PER_DAY } from '../types.js';

export interface IndexPoint {
  observedAt: string;
  value: number;
}

export interface StaleRevenueFinding {
  moveAbsPct: number;
  detail: Record<string, unknown>;
}

const NEAR_DAYS = 7;

/**
 * Has usage moved enough since the revenue disclosure that the disclosed figure looks stale?
 * Compares the latest usage index with the one nearest the disclosure (within seven days), or,
 * when there is none, with the earliest available one, and says which. Pure.
 */
export function checkRevenueStale(revenueObservedAt: string, index: IndexPoint[], movePct: number): StaleRevenueFinding | null {
  if (index.length < 2) return null;
  const sorted = [...index].sort((a, b) => (a.observedAt < b.observedAt ? -1 : a.observedAt > b.observedAt ? 1 : 0));
  const t0 = new Date(revenueObservedAt).getTime();
  const distance = (p: IndexPoint) => Math.abs(new Date(p.observedAt).getTime() - t0);

  let base: IndexPoint | null = null;
  for (const p of sorted) {
    if (distance(p) <= NEAR_DAYS * MS_PER_DAY && (base === null || distance(p) < distance(base))) base = p;
  }
  const basis = base === null ? 'earliest_available' : 'near_disclosure';
  base ??= sorted[0];
  const latest = sorted[sorted.length - 1];
  if (latest === base || !(base.value > 0)) return null;

  const move = (latest.value / base.value - 1) * 100;
  if (!(Math.abs(move) > movePct)) return null;
  return {
    moveAbsPct: Math.abs(move),
    detail: {
      revenue_observed_at: revenueObservedAt,
      index_at_disclosure: { value: base.value, observed_at: base.observedAt },
      index_latest: { value: latest.value, observed_at: latest.observedAt },
      move_pct: move,
      threshold_pct: movePct,
      basis,
      note:
        basis === 'earliest_available'
          ? `no usage_index value lies within ${NEAR_DAYS} days of the disclosure; compared against the earliest available one instead`
          : 'usage_index has moved since the revenue figure was disclosed; the disclosed revenue may be stale',
    },
  };
}
