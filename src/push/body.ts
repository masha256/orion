import { loadAsset } from '../config/load.js';
import type { Db } from '../db/connection.js';
import { listLatestLevels, type LatestLevel } from '../db/latestLevels.js';
import type { RegistryRow } from '../db/registry.js';
import { lastCompleteReportDay, loadHolderYieldReport } from '../report/load.js';
import { MS_PER_DAY } from '../types.js';

/**
 * The Phase 1.5 snapshot bodies (spec 9.1, minimal): per asset the `report yield --json --legacy` object (full) or the
 * `latest_levels` rows (levels), plus the registry state. Phase 5 defines the full body. Active and paused assets are
 * published; a paused asset is marked by its state (with since and reason) and keeps its last report.
 */

const published = (registry: RegistryRow[]): RegistryRow[] =>
  registry.filter((r) => r.state === 'active' || r.state === 'paused').sort((a, b) => (a.assetId < b.assetId ? -1 : 1));

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split('\n')[0];

/**
 * The day an active asset's report covers (I-7): `day`, or its last complete report day when its flows lag behind
 * (LIT by design; an EVM chain whose finalized block is still before 00:00Z), never a day with a missing flow.
 * Null when it has no income_statement block, no YAML, or no complete day yet.
 */
export async function assetReportDay(db: Db, configRoot: string, assetId: string, day: string): Promise<{ day: string; lagDays: number } | null> {
  let asset;
  try {
    asset = loadAsset(configRoot, assetId).config;
  } catch {
    return null;
  }
  if (!asset.income_statement) return null;
  const last = await lastCompleteReportDay(db, asset);
  const used = last !== null && last < day ? last : day;
  return { day: used, lagDays: Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${used}T00:00:00Z`)) / MS_PER_DAY) };
}

/** Active assets whose report lags `day`, with how many days (for the nightly's LAG lines). */
export async function reportLags(db: Db, configRoot: string, registry: RegistryRow[], day: string): Promise<{ assetId: string; lagDays: number }[]> {
  const out: { assetId: string; lagDays: number }[] = [];
  for (const r of published(registry)) {
    if (r.state !== 'active') continue;
    const d = await assetReportDay(db, configRoot, r.assetId, day);
    if (d && d.lagDays > 0) out.push({ assetId: r.assetId, lagDays: d.lagDays });
  }
  return out;
}

/**
 * `{ day, assets: { [id]: { state, state_since, state_reason, report_day, lag_days, report, report_error } } }`. An
 * active asset's report covers `day`, or its last complete day when its flows lag (`report_day`, `lag_days` days
 * behind); a paused asset's covers the newest day it has data for (its last report; `lag_days` null). An asset with no
 * report (no income_statement block, a YAML that does not load, not enough data) has `report: null` and the reason.
 */
export async function fullBody(db: Db, configRoot: string, registry: RegistryRow[], day: string): Promise<unknown> {
  const assets: Record<string, unknown> = {};
  for (const r of published(registry)) {
    let report: unknown = null;
    let reportError: string | null = null;
    let reportDay: string | null = null;
    let lagDays: number | null = null;
    try {
      const asset = loadAsset(configRoot, r.assetId).config;
      if (!asset.income_statement) {
        reportError = 'no income_statement block';
      } else {
        const used = r.state === 'active' ? await assetReportDay(db, configRoot, r.assetId, day) : null;
        if (used) {
          reportDay = used.day;
          lagDays = used.lagDays;
        }
        // The `--json --legacy` object exactly (P2: v2 and the legacy keys during the legacy release): what JSON.stringify keeps of it.
        report = JSON.parse(JSON.stringify(await loadHolderYieldReport(db, asset, used?.day, { legacy: true }))) as unknown;
        if (reportDay === null) reportDay = (report as { day?: string }).day ?? null;
      }
    } catch (err) {
      reportError = message(err);
    }
    assets[r.assetId] = { state: r.state, state_since: r.stateSince, state_reason: r.stateReason, report_day: reportDay, lag_days: lagDays, report, report_error: reportError };
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
