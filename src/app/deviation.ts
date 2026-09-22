import type { AssetConfig } from '../config/schema.js';
import { lastCompletedRun } from '../db/agentRuns.js';
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
  /** Where `asOf` came from: the last completed agent run's start, else the current assumption set's creation. */
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
 * The point the base scenario's path is measured from: the last time an analyst reviewed the assumptions against the
 * data. Pure functions over stored rows, so the same anchor is computed on every tick until the next review.
 */
export function revenueAnchor(db: Db, asset: AssetConfig): RevenueAnchor | null {
  const run = lastCompletedRun(db, asset.id);
  const set = getLatestAssumptionSet(db, asset.id);
  const at = run ? { asOf: run.startedAt, from: 'agent_run' as const } : set ? { asOf: set.createdAt, from: 'assumption_set' as const } : null;
  if (!at) return null;
  const report = computeDrivers(asset, eligibleObservations(db, asset, at.asOf), at.asOf, requiredExtraMetrics(asset));
  const revenue = report.drivers?.revenueRunRate;
  if (!revenue) return null;
  return { value: revenue.value, asOf: at.asOf, from: at.from };
}

/**
 * Where the base scenario said revenue would be by `now`, against where it is. Null when the anchor is too young to
 * measure against, or the implied path is not positive. Elapsed years are measured with the engine's own DAYS_PER_YEAR.
 */
export function revenueDeviation(anchor: { value: number; asOf: string }, actual: number, base: ScenarioAssumptions, now: Date): RevenueDeviation | null {
  const elapsedMs = now.getTime() - new Date(anchor.asOf).getTime();
  if (elapsedMs < DEVIATION_MIN_ANCHOR_AGE_DAYS * MS_PER_DAY) return null;
  const elapsedYears = elapsedMs / (DAYS_PER_YEAR * MS_PER_DAY);
  const implied = revenueAt(elapsedYears, anchor.value, base);
  if (!(implied > 0)) return null;
  return {
    anchor_value: anchor.value, anchor_as_of: anchor.asOf, elapsed_years: elapsedYears, implied, actual,
    deviation_pct: (actual / implied - 1) * 100,
  };
}
