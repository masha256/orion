import { DAYS_PER_YEAR } from '../types.js';
import { addDays } from './time.js';

/** Derived metrics are computed from stored observations after the fetch phase. */
export const DERIVED_NAMES: readonly string[] = ['burn_momentum', 'flow_annualized'];
export type DerivedName = 'burn_momentum' | 'flow_annualized';

/**
 * The sum over `windowDays` consecutive days, for every day that has a complete window ending on it.
 * `days` maps a UTC day to that day's flow. A missing day breaks the window: nothing is filled in.
 * Oldest first.
 */
function windowSums(days: Map<string, number>, windowDays: number): { day: string; sum: number }[] {
  const out: { day: string; sum: number }[] = [];
  for (const day of [...days.keys()].sort()) {
    let sum = 0;
    let complete = true;
    for (let i = 0; i < windowDays && complete; i++) {
      const v = days.get(addDays(day, -i));
      if (v === undefined) complete = false;
      else sum += v;
    }
    if (complete) out.push({ day, sum });
  }
  return out;
}

/** Mean value per day over the window: momentum, in the flow's unit per day. */
export function burnMomentum(days: Map<string, number>, windowDays: number): { day: string; value: number }[] {
  return windowSums(days, windowDays).map(({ day, sum }) => ({ day, value: sum / windowDays }));
}

/** The window's sum scaled to a year: a run rate, in the flow's unit per year. */
export function flowAnnualized(days: Map<string, number>, windowDays: number): { day: string; value: number }[] {
  return windowSums(days, windowDays).map(({ day, sum }) => ({ day, value: (sum * DAYS_PER_YEAR) / windowDays }));
}

export function derivedFunction(name: DerivedName): (days: Map<string, number>, windowDays: number) => { day: string; value: number }[] {
  return name === 'flow_annualized' ? flowAnnualized : burnMomentum;
}
