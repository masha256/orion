import type { AssetConfig } from '../config/schema.js';
import { getLatestAssumptionSet } from '../db/assumptions.js';
import type { Db } from '../db/connection.js';
import { computeDrivers } from '../drivers/compute.js';
import { revenueAt } from '../engine/paths.js';
import { requiredExtraMetrics } from '../engine/requirements.js';
import { DAYS_PER_YEAR, MS_PER_DAY, type ScenarioAssumptions } from '../types.js';
import { eligibleObservations } from './eligibility.js';

/** A week of growth is inside the noise of a run-rate figure: an anchor younger than this is not measured against. */
export const DEVIATION_MIN_ANCHOR_AGE_DAYS = 7;

export interface RevenueAnchor {
  /** The revenue driver as of `asOf`, from the observations usable then. */
  value: number;
  asOf: string;
  /** Where `asOf` came from: always the current assumption set's creation. Kept for the report and the pack. */
  from: 'agent_run' | 'assumption_set';
}

export interface RevenueDeviation {
  anchor_value: number;
  anchor_as_of: string;
  elapsed_years: number;
  implied: number;
  actual: number;
  deviation_pct: number;
}

/**
 * The point the base scenario's path is measured from: the current assumption set's creation. A review that changed
 * nothing does not reset the clock; an assumption change (the agent's or the user's) creates a new set and moves the
 * anchor. Pure function over stored rows, so the same anchor is computed on every tick until the next assumption change.
 */
export function revenueAnchor(db: Db, asset: AssetConfig): RevenueAnchor | null {
  const set = getLatestAssumptionSet(db, asset.id);
  const asOf = set?.createdAt ?? null;
  if (asOf === null) return null;
  const report = computeDrivers(asset, eligibleObservations(db, asset, asOf), asOf, requiredExtraMetrics(asset));
  const revenue = report.drivers?.revenueRunRate;
  if (!revenue) return null;
  return { value: revenue.value, asOf, from: 'assumption_set' };
}

/**
 * Where the base scenario said revenue would be by `now`, against where it is. Null when the anchor is too young to
 * measure against, or the implied path is not positive. Elapsed years are measured with the engine's own DAYS_PER_YEAR.
 */
export function revenueDeviation(anchor: { value: number; asOf: string }, actual: number, base: ScenarioAssumptions, now: Date): RevenueDeviation | null {
  const elapsedMs = now.getTime() - new Date(anchor.asOf).getTime();
  // The two ends of the interval are read after fetches of different length; half a tick of slack keeps a run from
  // slipping a day on jitter.
  if (elapsedMs < (DEVIATION_MIN_ANCHOR_AGE_DAYS - 0.5) * MS_PER_DAY) return null;
  const elapsedYears = elapsedMs / (DAYS_PER_YEAR * MS_PER_DAY);
  const implied = revenueAt(elapsedYears, anchor.value, base);
  if (!(implied > 0)) return null;
  return {
    anchor_value: anchor.value, anchor_as_of: anchor.asOf, elapsed_years: elapsedYears, implied, actual,
    deviation_pct: (actual / implied - 1) * 100,
  };
}
