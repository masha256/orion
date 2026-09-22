import { parseAssetObject, type LoadedAsset } from '../config/load.js';
import type { AssetConfig } from '../config/schema.js';
import { listOpenAnomalies } from '../db/anomalies.js';
import { getAssumptionSetById, getLatestAssumptionSet } from '../db/assumptions.js';
import type { Db } from '../db/connection.js';
import { getObservationsByIds, type Observation } from '../db/observations.js';
import {
  createSnapshot, getConfigVersion, getLatestSignal, getSnapshot, getValuationRun, insertSignal, insertValuationRun,
  saveConfigVersion, updateRunStatus,
} from '../db/runs.js';
import { computeDrivers, type Drivers } from '../drivers/compute.js';
import { latestLevel } from '../drivers/select.js';
import { EngineError } from '../engine/errors.js';
import { requiredExtraMetrics, validateAssetModules, validateAssumptions } from '../engine/requirements.js';
import { runEngine, type EngineOutput } from '../engine/run.js';
import { ENGINE_VERSION } from '../engine/version.js';
import { buildSignal } from '../signals/build.js';
import type { Signal } from '../signals/schema.js';
import { OrionError, SCENARIOS, STD_METRICS, type AssumptionValues, type Scenario } from '../types.js';
import { canonicalJson } from '../util/canonical.js';
import { eligibleObservations, narrowToUsable } from './eligibility.js';

function tryEngine(asset: AssetConfig, drivers: Drivers, values: AssumptionValues): { output: EngineOutput } | { error: string } {
  try {
    return { output: runEngine({ asset, drivers, assumptions: values }) };
  } catch (err) {
    if (err instanceof EngineError) return { error: err.message };
    throw err;
  }
}

function compactStamp(iso: string): string {
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export function runValuation(
  db: Db,
  loaded: LoadedAsset,
  now: Date,
  opts: { agentRunId?: number } = {},
): { runId: number; signal: Signal } {
  const { config: asset, hash } = loaded;
  const asOf = now.toISOString();

  // IMMEDIATE: the snapshot is read long before the run is written. A deferred transaction takes the write lock only at
  // that first write, and a commit by another connection in between fails it outright with SQLITE_BUSY_SNAPSHOT, which
  // busy_timeout cannot retry away. Taking the lock at BEGIN makes the other connection wait instead.
  return db.transaction(() => {
    saveConfigVersion(db, hash, asset.id, asset, asOf);
    const observations = eligibleObservations(db, asset, asOf);
    const snapshotId = createSnapshot(db, asset.id, asOf, observations.map((o) => o.id), asOf);
    const report = computeDrivers(asset, observations, asOf, requiredExtraMetrics(asset));
    const set = getLatestAssumptionSet(db, asset.id);

    const reasons: string[] = [
      ...validateAssetModules(asset).map((e) => `invalid_config:${e}`),
      ...report.missing.map((m) => `missing_metric:${m}`),
      ...report.overlappingFlowMetrics.map((m) => `overlapping_flow_periods:${m}`),
    ];
    if (!set) reasons.push('no_assumption_set');
    else reasons.push(...validateAssumptions(asset, set.values).map((e) => `invalid_assumptions:${e}`));

    let engine: EngineOutput | null = null;
    if (reasons.length === 0 && report.drivers && set) {
      const r = tryEngine(asset, report.drivers, set.values);
      if ('output' in r) engine = r.output;
      else reasons.push(`engine_error:${r.error}`);
    }

    const runId = insertValuationRun(db, {
      assetId: asset.id,
      snapshotId,
      assumptionSetId: set?.id ?? null,
      engineVersion: ENGINE_VERSION,
      configHash: hash,
      status: 'pending',
      outputJson: engine ? canonicalJson(engine) : null,
      createdAt: asOf,
      agentRunId: opts.agentRunId ?? null,
    });

    const prev = getLatestSignal(db, asset.id);
    const causes: NonNullable<Signal['change']['causes']> = [];
    let delta: number | null = null;
    if (prev) {
      const prevSnapshot = getSnapshot(db, prev.provenance.snapshot_id);
      const dataChanged = JSON.stringify(prevSnapshot?.observationIds ?? []) !== JSON.stringify(observations.map((o) => o.id).sort((a, b) => a - b));
      const assumptionsChanged = prev.provenance.assumption_set_version !== (set?.version ?? null);
      // A config change (an approved proposal, or a hand edit) moves the target for a reason a consumer could not otherwise see.
      const configChanged = prev.provenance.config_hash !== hash;
      if (dataChanged) causes.push('data');
      if (assumptionsChanged) causes.push('assumptions');
      if (configChanged) causes.push('config');
      const before = prev.horizons?.['12m'].expected_target;
      const after = engine?.horizons['12m'].expectedTarget;
      if (before !== undefined && after !== undefined && before !== 0) delta = (after / before - 1) * 100;
    }

    const cause: Signal['change']['cause'] = causes.length > 1 ? 'both' : (causes[0] ?? 'none');
    const assumptionsAreACause = causes.includes('assumptions');

    const priceObs = latestLevel(observations.filter((o) => o.metricKey === STD_METRICS.price), asOf);
    const signal = buildSignal({
      signalId: `${asset.id}-${compactStamp(asOf)}-${runId}`,
      asset,
      generatedAt: asOf,
      report,
      engine,
      blockedReasons: reasons,
      spotFallback: priceObs ? { price: priceObs.value, ts: priceObs.observedAt } : null,
      // Read at run time and deliberately outside the snapshot: replay reproduces engine output only.
      openAnomalies: listOpenAnomalies(db, asset.id),
      change: {
        prev_signal_id: prev?.signal_id ?? null,
        target_delta_pct: delta,
        cause,
        causes,
        author: set && assumptionsAreACause ? set.author : null,
        rationale: set && assumptionsAreACause ? set.rationale : '',
      },
      provenance: {
        run_id: runId,
        snapshot_id: snapshotId,
        assumption_set_version: set?.version ?? null,
        engine_version: ENGINE_VERSION,
        config_hash: hash,
        agent_run_id: opts.agentRunId ?? null,
      },
    });

    updateRunStatus(db, runId, signal.status);
    insertSignal(db, runId, signal);
    return { runId, signal };
  }).immediate();
}

export interface WhatIfOptions {
  /** Run with this config instead of the loaded one: how a config proposal's effect is computed. */
  config?: AssetConfig;
  /**
   * Observations to treat as eligible although they are not (yet) in the database, or not yet eligible: staged research,
   * a proposed observation, a provisional row whose confirmation is proposed. Each displaces any eligible row with the
   * same metric and observed-at, as a confirmed insert would supersede it.
   */
  addObservations?: Observation[];
  /** Eligible observations to leave out: how rejecting one is previewed. */
  removeObservationIds?: number[];
}

/** Eligible observations with the what-if additions and removals applied, narrowed again so a new level displaces the old. */
function whatIfObservations(db: Db, asset: AssetConfig, asOf: string, opts: WhatIfOptions): Observation[] {
  const eligible = eligibleObservations(db, asset, asOf);
  const add = opts.addObservations ?? [];
  if (add.length === 0 && (opts.removeObservationIds ?? []).length === 0) return eligible;
  const removed = new Set(opts.removeObservationIds ?? []);
  const displaced = new Set(add.map((o) => `${o.metricKey}@${o.observedAt}`));
  const kept = eligible.filter((o) => !removed.has(o.id) && !displaced.has(`${o.metricKey}@${o.observedAt}`));
  return narrowToUsable(asset, [...kept, ...add], asOf);
}

export function whatIf(
  db: Db,
  loaded: LoadedAsset,
  now: Date,
  overrides: { key: string; value: number; scenario?: Scenario }[],
  opts: WhatIfOptions = {},
): { blocked: string[] } | { output: EngineOutput } {
  const asset = opts.config ?? loaded.config;
  const asOf = now.toISOString();
  const report = computeDrivers(asset, whatIfObservations(db, asset, asOf, opts), asOf, requiredExtraMetrics(asset));
  const set = getLatestAssumptionSet(db, asset.id);
  const blocked = [
    ...validateAssetModules(asset).map((e) => `invalid_config:${e}`),
    ...report.missing.map((m) => `missing_metric:${m}`),
    ...report.overlappingFlowMetrics.map((m) => `overlapping_flow_periods:${m}`),
  ];
  if (!set) blocked.push('no_assumption_set');
  if (blocked.length > 0 || !set || !report.drivers) return { blocked };

  const values: AssumptionValues = { bear: { ...set.values.bear }, base: { ...set.values.base }, bull: { ...set.values.bull } };
  for (const o of overrides) {
    for (const s of o.scenario ? [o.scenario] : SCENARIOS) values[s][o.key] = o.value;
  }
  const errors = validateAssumptions(asset, values, { checkBounds: false });
  if (errors.length > 0) return { blocked: errors.map((e) => `invalid_assumptions:${e}`) };

  const r = tryEngine(asset, report.drivers, values);
  return 'output' in r ? { output: r.output } : { blocked: [`engine_error:${r.error}`] };
}

export function replayRun(db: Db, runId: number): { identical: boolean; stored: string; replayed: string } {
  const run = getValuationRun(db, runId);
  if (!run) throw new OrionError('run_not_found', `no valuation run with id ${runId}`);
  if (run.outputJson === null || run.assumptionSetId === null) {
    throw new OrionError('not_replayable', `run ${runId} was blocked and has no engine output to replay`);
  }
  if (run.engineVersion !== ENGINE_VERSION) {
    throw new OrionError('engine_version_mismatch', `run ${runId} used engine ${run.engineVersion}; this build is ${ENGINE_VERSION}`);
  }
  const content = getConfigVersion(db, run.configHash);
  const snapshot = getSnapshot(db, run.snapshotId);
  const set = getAssumptionSetById(db, run.assumptionSetId);
  if (!content || !snapshot || !set) throw new OrionError('not_replayable', `run ${runId} is missing stored inputs`);

  const asset = parseAssetObject(JSON.parse(content)).config;
  const observations = getObservationsByIds(db, snapshot.observationIds);
  const report = computeDrivers(asset, observations, snapshot.asOf, requiredExtraMetrics(asset));
  if (!report.drivers) throw new OrionError('not_replayable', `run ${runId} inputs no longer produce drivers`);
  const replayed = canonicalJson(runEngine({ asset, drivers: report.drivers, assumptions: set.values }));
  return { identical: replayed === run.outputJson, stored: run.outputJson, replayed };
}
