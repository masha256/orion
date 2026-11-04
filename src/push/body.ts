import { loadAsset } from '../config/load.js';
import type { Db } from '../db/connection.js';
import { listLatestLevels, type LatestLevel } from '../db/latestLevels.js';
import type { RegistryRow } from '../db/registry.js';
import { loadHolderYieldReport } from '../report/load.js';

/**
 * The Phase 1.5 snapshot bodies (spec 9.1, minimal): per asset the `report yield --json` object (full) or the
 * `latest_levels` rows (levels), plus the registry state. Phase 5 defines the full body. Active and paused assets are
 * published; a paused asset is marked by its state (with since and reason) and keeps its last report.
 */

const published = (registry: RegistryRow[]): RegistryRow[] =>
  registry.filter((r) => r.state === 'active' || r.state === 'paused').sort((a, b) => (a.assetId < b.assetId ? -1 : 1));

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split('\n')[0];

/**
 * `{ day, assets: { [id]: { state, state_since, state_reason, report, report_error } } }`. An active asset's report
 * covers `day`; a paused asset's covers the newest day it has data for (its last report). An asset with no report
 * (no reporting block, a YAML that does not load, not enough data) has `report: null` and the reason.
 */
export async function fullBody(db: Db, configRoot: string, registry: RegistryRow[], day: string): Promise<unknown> {
  const assets: Record<string, unknown> = {};
  for (const r of published(registry)) {
    let report: unknown = null;
    let reportError: string | null = null;
    try {
      const asset = loadAsset(configRoot, r.assetId).config;
      if (!asset.reporting) {
        reportError = 'no reporting block';
      } else {
        // The --json object exactly: what JSON.stringify keeps of it.
        report = JSON.parse(JSON.stringify(await loadHolderYieldReport(db, asset, r.state === 'active' ? day : undefined))) as unknown;
      }
    } catch (err) {
      reportError = message(err);
    }
    assets[r.assetId] = { state: r.state, state_since: r.stateSince, state_reason: r.stateReason, report, report_error: reportError };
  }
  return { day, assets };
}

/** `{ assets: { [id]: { state, levels } } }` with every `latest_levels` row of each active or paused asset. */
export async function levelsBody(db: Db, registry: RegistryRow[]): Promise<unknown> {
  const assets: Record<string, { state: string; levels: LatestLevel[] }> = {};
  for (const r of published(registry)) assets[r.assetId] = { state: r.state, levels: await listLatestLevels(db, r.assetId) };
  return { assets };
}

/** `assets.json`: `{ [id]: { state, since, reason } }` for active and paused assets. */
export function assetsFile(registry: RegistryRow[]): Record<string, { state: string; since: string; reason: string | null }> {
  const out: Record<string, { state: string; since: string; reason: string | null }> = {};
  for (const r of published(registry)) out[r.assetId] = { state: r.state, since: r.stateSince, reason: r.stateReason };
  return out;
}
