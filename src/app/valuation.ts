import { parseAssetObject, type LoadedAsset } from '../config/load.js';
import type { AssetConfig } from '../config/schema.js';
import { getAssumptionSetById, getLatestAssumptionSet } from '../db/assumptions.js';
import type { Db } from '../db/connection.js';
import { getObservationsByIds, listActiveObservations, type Observation } from '../db/observations.js';
import {
  createSnapshot, getConfigVersion, getLatestSignal, getSnapshot, getValuationRun, insertSignal, insertValuationRun,
  saveConfigVersion, updateRunStatus,
} from '../db/runs.js';
import { computeDrivers, type Drivers } from '../drivers/compute.js';
import { latestLevel } from '../drivers/select.js';
import { EngineError } from '../engine/errors.js';
import { requiredExtraMetrics, validateAssumptions } from '../engine/requirements.js';
import { runEngine, type EngineOutput } from '../engine/run.js';
import { ENGINE_VERSION } from '../engine/version.js';
import { buildSignal } from '../signals/build.js';
import type { Signal } from '../signals/schema.js';
import { OrionError, SCENARIOS, STD_METRICS, type AssumptionValues, type Scenario } from '../types.js';
import { canonicalJson } from '../util/canonical.js';

function eligibleObservations(db: Db, asset: AssetConfig): Observation[] {
  return listActiveObservations(db, asset.id).filter((o) => {
    const def = asset.metrics[o.metricKey];
    return def !== undefined && (o.status === 'confirmed' || def.allow_provisional);
  });
}

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

export function runValuation(db: Db, loaded: LoadedAsset, now: Date): { runId: number; signal: Signal } {
  const { config: asset, hash } = loaded;
  const asOf = now.toISOString();

  return db.transaction(() => {
    saveConfigVersion(db, hash, asset.id, asset, asOf);
    const observations = eligibleObservations(db, asset);
    const snapshotId = createSnapshot(db, asset.id, asOf, observations.map((o) => o.id), asOf);
    const report = computeDrivers(asset, observations, asOf, requiredExtraMetrics(asset));
    const set = getLatestAssumptionSet(db, asset.id);

    const reasons: string[] = [
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
    });

    const prev = getLatestSignal(db, asset.id);
    let cause: Signal['change']['cause'] = 'none';
    let delta: number | null = null;
    if (prev) {
      const prevSnapshot = getSnapshot(db, prev.provenance.snapshot_id);
      const dataChanged = JSON.stringify(prevSnapshot?.observationIds ?? []) !== JSON.stringify(observations.map((o) => o.id).sort((a, b) => a - b));
      const assumptionsChanged = prev.provenance.assumption_set_version !== (set?.version ?? null);
      cause = dataChanged && assumptionsChanged ? 'both' : dataChanged ? 'data' : assumptionsChanged ? 'assumptions' : 'none';
      const before = prev.horizons?.['12m'].expected_target;
      const after = engine?.horizons['12m'].expectedTarget;
      if (before !== undefined && after !== undefined && before !== 0) delta = (after / before - 1) * 100;
    }

    const priceObs = latestLevel(observations.filter((o) => o.metricKey === STD_METRICS.price), asOf);
    const signal = buildSignal({
      signalId: `${asset.id}-${compactStamp(asOf)}-${runId}`,
      asset,
      generatedAt: asOf,
      report,
      engine,
      blockedReasons: reasons,
      spotFallback: priceObs ? { price: priceObs.value, ts: priceObs.observedAt } : null,
      change: {
        prev_signal_id: prev?.signal_id ?? null,
        target_delta_pct: delta,
        cause,
        rationale: set && (cause === 'assumptions' || cause === 'both') ? set.rationale : '',
      },
      provenance: {
        run_id: runId,
        snapshot_id: snapshotId,
        assumption_set_version: set?.version ?? null,
        engine_version: ENGINE_VERSION,
        config_hash: hash,
      },
    });

    updateRunStatus(db, runId, signal.status);
    insertSignal(db, runId, signal);
    return { runId, signal };
  })();
}

export function whatIf(
  db: Db,
  loaded: LoadedAsset,
  now: Date,
  overrides: { key: string; value: number; scenario?: Scenario }[],
): { blocked: string[] } | { output: EngineOutput } {
  const asset = loaded.config;
  const asOf = now.toISOString();
  const report = computeDrivers(asset, eligibleObservations(db, asset), asOf, requiredExtraMetrics(asset));
  const set = getLatestAssumptionSet(db, asset.id);
  const blocked = [
    ...report.missing.map((m) => `missing_metric:${m}`),
    ...report.overlappingFlowMetrics.map((m) => `overlapping_flow_periods:${m}`),
  ];
  if (!set) blocked.push('no_assumption_set');
  if (!set || !report.drivers) return { blocked };

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
