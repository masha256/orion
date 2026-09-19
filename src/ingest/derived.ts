import { addDays } from './time.js';

/** Derived metrics are computed from stored observations after the fetch phase. */
export const DERIVED_NAMES: readonly string[] = ['burn_momentum'];

/**
 * Mean value per day over `windowDays` consecutive days, for every day that has a complete window
 * ending on it. `days` maps a UTC day to that day's flow. A missing day breaks the window: nothing
 * is filled in. Oldest first.
 */
export function burnMomentum(days: Map<string, number>, windowDays: number): { day: string; value: number }[] {
  const out: { day: string; value: number }[] = [];
  for (const day of [...days.keys()].sort()) {
    let sum = 0;
    let complete = true;
    for (let i = 0; i < windowDays && complete; i++) {
      const v = days.get(addDays(day, -i));
      if (v === undefined) complete = false;
      else sum += v;
    }
    if (complete) out.push({ day, value: sum / windowDays });
  }
  return out;
}
