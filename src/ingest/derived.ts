import { DAYS_PER_YEAR } from '../types.js';
import { addDays } from './time.js';

/** Derived metrics are computed from stored observations after the fetch phase. */
export const DERIVED_NAMES: readonly string[] = ['burn_momentum', 'flow_annualized', 'level_gap_pct'];
export type DerivedName = 'burn_momentum' | 'flow_annualized' | 'level_gap_pct';

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

/** The flow-window kinds (burn_momentum, flow_annualized); level_gap_pct has no window and is not one. */
export function derivedFunction(name: DerivedName): (days: Map<string, number>, windowDays: number) => { day: string; value: number }[] {
  if (name === 'level_gap_pct') throw new Error('level_gap_pct compares two levels; it has no flow window');
  return name === 'flow_annualized' ? flowAnnualized : burnMomentum;
}

/**
 * `level_gap_pct` (Phase 3 R3, Ruling R3): how far level `a` sits from level `b`, in percent, (a / b - 1) x 100, from
 * this run's readings of both. A monitor-only level for a `watch: { outside: [lo, hi] }` check of a figure against a
 * first-party one (CRV against Curve's circulating_supply(), LINK against supply.chain.link). Null when b is 0.
 */
export function levelGapPct(a: number, b: number): number | null {
  return b === 0 ? null : (a / b - 1) * 100;
}

const LEVEL_GAP_KEYS = ['a', 'b'];

/**
 * The configuration issues of a `level_gap_pct` source on metric `key` (checked at load): params exactly { a, b }, two
 * different level metrics of the asset that are read in the run (a source, not a derived or constant one, not the gap
 * itself), and the gap metric a monitor-only level (a check, never report data).
 */
export function levelGapIssues(
  key: string,
  def: { type: string; monitor_only?: boolean },
  params: Record<string, unknown> | undefined,
  metrics: Readonly<Record<string, { type: string; source?: { type: string } }>>,
): string[] {
  const where = `metrics.${key}: level_gap_pct`;
  const p = params ?? {};
  const out = Object.keys(p).filter((k) => !LEVEL_GAP_KEYS.includes(k)).map((k) => `${where} takes only "a" and "b", not "${k}"`);
  if (def.type !== 'level') out.push(`${where} is a level, not a ${def.type}`);
  if (def.monitor_only !== true) out.push(`${where} is a check: the metric must be monitor_only`);
  for (const side of LEVEL_GAP_KEYS) {
    const m = p[side];
    if (typeof m !== 'string') {
      out.push(`${where} "${side}" must name a level metric`);
      continue;
    }
    const d = metrics[m];
    if (m === key) out.push(`${where} "${side}" cannot be the gap metric itself`);
    else if (d === undefined) out.push(`${where} "${side}": unknown metric "${m}"`);
    else if (d.type !== 'level') out.push(`${where} "${side}": "${m}" is a ${d.type} metric, not a level`);
    else if (d.source === undefined || d.source.type === 'derived' || d.source.type === 'constant') out.push(`${where} "${side}": "${m}" must be read this run (a source, not derived or constant)`);
  }
  if (typeof p.a === 'string' && p.a === p.b) out.push(`${where} "a" and "b" must be different metrics`);
  return out;
}
