import type { LoadedAsset } from '../config/load.js';
import type { MetricDef } from '../config/schema.js';
import { isChainSource } from '../config/sources.js';
import { raiseAnomaly } from '../db/anomalies.js';
import type { Db } from '../db/connection.js';
import { emptySourceOutcome, insertFetchRun, recentSourceStatuses, type FetchOutcome, type SourceOutcome } from '../db/fetchRuns.js';
import { insertObservation } from '../db/observations.js';
import { OrionError } from '../types.js';
import { getAdapter } from './adapters/registry.js';
import { compareLevel } from './crosscheck.js';
import { buildPlan, hasSources, type SourceBatch } from './plan.js';
import { sourceId } from './sourceId.js';
import { getSourceHandler } from './sources/registry.js';
import { withRunCache, type HttpTransport } from './transport/http.js';
import type { BlockRef, RpcFactory, RpcTransport } from './transport/rpc.js';
import {
  contractResolver, failed, type RaisedAnomaly, type ReadingResult, type SourceContext, type SourceRequest, type WrittenObservation,
} from './types.js';

/** Used when the asset's rpc_url_env variable is not set. */
export const DEFAULT_RPC_URLS: Record<number, string> = { 8453: 'https://mainnet.base.org' };

export interface FetchDeps {
  http: HttpTransport;
  rpcFactory: RpcFactory;
  env: Record<string, string | undefined>;
  sleep(ms: number): Promise<void>;
  now(): Date;
}

export interface FetchOptions {
  metrics?: string[];
  /** Scan this many days back, ignoring the cursor. Default: resume from the cursor, or the asset's backfill_days on a first run. */
  backfillDays?: number;
  adopt?: boolean;
  dryRun?: boolean;
  onProgress?: (line: string) => void;
}

export interface FetchResult {
  assetId: string;
  dryRun: boolean;
  fetchRunId: number | null;
  outcome: FetchOutcome;
  startedAt: string;
  endedAt: string;
  sources: SourceOutcome[];
  written: WrittenObservation[];
  anomalies: RaisedAnomaly[];
}

/**
 * Null when a fetched value may be stored. A reading that is not finite, or a supply or price that
 * is not positive, is a source failure, never an observation.
 */
export function validateReading(def: MetricDef, value: number): string | null {
  if (!Number.isFinite(value)) return `${value} is not a finite number`;
  if (def.type === 'level') {
    if (def.unit === 'ratio') return value >= 0 && value <= 1 ? null : `ratio ${value} is outside [0, 1]`;
    return value > 0 ? null : `${value} is not positive`;
  }
  return value >= 0 ? null : `${value} is negative`;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function markFailed(outcome: SourceOutcome, text: string): void {
  outcome.status = 'failed';
  outcome.error = outcome.error === null ? text : `${outcome.error}; ${text}`;
}

function readsChain(batch: SourceBatch): boolean {
  return batch.requests.some((r) => isChainSource(r.source) || (r.source.type === 'adapter' && getAdapter(r.source.name).needsRpc));
}

export async function fetchAsset(db: Db, loaded: LoadedAsset, now: Date, deps: FetchDeps, opts: FetchOptions = {}): Promise<FetchResult> {
  const asset = loaded.config;
  if (!hasSources(asset)) throw new OrionError('no_sources', `assets/${asset.id}.yaml defines no metric source; there is nothing to fetch`);
  const plan = buildPlan(asset, { metrics: opts.metrics });
  const startedAt = now.toISOString();
  const dryRun = opts.dryRun ?? false;

  let rpc: RpcTransport | null = null;
  let block: BlockRef | null = null;
  let chainError: string | null = null;
  if (plan.needsRpc) {
    const ingest = asset.ingest!; // buildPlan guarantees it
    const url = deps.env[ingest.rpc_url_env] ?? DEFAULT_RPC_URLS[ingest.chain_id];
    if (!url) throw new OrionError('missing_rpc_url', `set ${ingest.rpc_url_env}: there is no default RPC URL for chain ${ingest.chain_id}`);
    rpc = deps.rpcFactory(url, ingest.chain_id);
    try {
      block = await rpc.latestBlock();
    } catch (err) {
      chainError = `could not read the latest block: ${message(err)}`;
    }
  }

  const ctx: SourceContext = {
    asset, nowIso: startedAt, http: withRunCache(deps.http), rpc, block, env: deps.env, contract: contractResolver(asset),
  };

  const outcomes = new Map<string, SourceOutcome>();
  const outcomeOf = (id: string): SourceOutcome => {
    let o = outcomes.get(id);
    if (!o) {
      o = emptySourceOutcome(id);
      outcomes.set(id, o);
    }
    return o;
  };
  const written: WrittenObservation[] = [];
  const anomalies: RaisedAnomaly[] = [];
  const raise = (a: Omit<RaisedAnomaly, 'id'>): void => {
    const id = dryRun ? null : raiseAnomaly(db, { assetId: asset.id, ...a, seenAt: startedAt }).id;
    anomalies.push({ id, ...a });
  };

  // 1. Fetch phase: one batch at a time. A thrown handler fails its whole batch and nothing else.
  const readings = new Map<SourceRequest, ReadingResult>();
  for (const batch of plan.batches) {
    outcomeOf(batch.sourceId);
    let results: ReadingResult[];
    if (chainError !== null && readsChain(batch)) {
      results = batch.requests.map(() => failed(chainError));
    } else {
      try {
        results = await getSourceHandler(batch.requests[0].source.type).fetch(batch.requests, ctx);
      } catch (err) {
        if (err instanceof OrionError) throw err; // configuration error
        results = batch.requests.map(() => failed(message(err)));
      }
    }
    batch.requests.forEach((r, i) => readings.set(r, results[i] ?? failed('the source returned no result for this request')));
  }

  // 2. Primaries: validate, then write through insertObservation with the source's own timestamp.
  const primaryValue = new Map<string, number>();
  for (const batch of plan.batches) {
    for (const r of batch.requests) {
      if (r.role !== 'primary') continue;
      const outcome = outcomeOf(batch.sourceId);
      const result = readings.get(r)!;
      if (!result.ok) {
        markFailed(outcome, `${r.metricKey}: ${result.error}`);
        continue;
      }
      if (result.value.kind !== 'level') {
        markFailed(outcome, `${r.metricKey}: a ${result.value.kind} cannot be stored as an observation`);
        continue;
      }
      const v = result.value;
      const refusal = validateReading(asset.metrics[r.metricKey], v.value);
      if (refusal !== null) {
        markFailed(outcome, `${r.metricKey}: ${refusal}`);
        continue;
      }
      const observationId = dryRun
        ? null
        : insertObservation(db, {
            assetId: asset.id, metricKey: r.metricKey, observedAt: v.observedAt, value: v.value, source: v.source,
            sourceDetail: v.detail, fetchedAt: startedAt,
          }).id;
      outcome.metricsWritten.push(r.metricKey);
      written.push({ metricKey: r.metricKey, value: v.value, observedAt: v.observedAt, periodDays: null, source: v.source, observationId });
      primaryValue.set(r.metricKey, v.value);
    }
  }

  // 3. Level cross-checks, against the primary reading of this run. Never stored as observations.
  for (const batch of plan.batches) {
    for (const r of batch.requests) {
      const def = asset.metrics[r.metricKey];
      if (r.role !== 'cross_check' || def.type === 'flow') continue;
      const outcome = outcomeOf(batch.sourceId);
      const result = readings.get(r)!;
      if (!result.ok) {
        markFailed(outcome, `${r.metricKey}: ${result.error}`);
        continue;
      }
      if (result.value.kind !== 'level') {
        markFailed(outcome, `${r.metricKey}: expected a level reading, got a ${result.value.kind}`);
        continue;
      }
      const check = result.value.value;
      const refusal = validateReading(def, check);
      if (refusal !== null) {
        markFailed(outcome, `${r.metricKey}: ${refusal}`);
        continue;
      }
      const primary = primaryValue.get(r.metricKey);
      if (primary === undefined) {
        outcome.notes.push(`${r.metricKey}: cross-check skipped, the primary source gave no reading this run`);
        continue;
      }
      const cmp = compareLevel(primary, check, r.tolerancePct);
      outcome.crossChecks.push({
        metricKey: r.metricKey, sourceId: batch.sourceId, label: 'level', primary, check, diffPct: cmp.diffPct, tolerancePct: r.tolerancePct, ok: cmp.ok,
      });
      if (!cmp.ok) {
        raise({
          kind: 'cross_check_mismatch', metricKey: r.metricKey, dedupeKey: batch.sourceId, severity: def.critical ? 'degrading' : 'advisory',
          detail: {
            primary, check, diff_pct: cmp.diffPct, tolerance_pct: r.tolerancePct,
            primary_source: sourceId(def.source!), check_source: batch.sourceId,
          },
        });
      }
    }
  }

  // [Task 13 inserts the transfer scans and the monthly cross-checks here]

  // [Task 16 inserts the derived metrics and the stale-revenue alert here]

  // Failure streaks: this run plus the two previous attempts of the same source.
  for (const outcome of outcomes.values()) {
    if (outcome.status !== 'failed') continue;
    const previous = recentSourceStatuses(db, asset.id, outcome.sourceId, 2);
    if (previous.length === 2 && previous.every((s) => s === 'failed')) {
      raise({
        kind: 'source_failure_streak', metricKey: '', dedupeKey: outcome.sourceId, severity: 'advisory',
        detail: { source: outcome.sourceId, error: outcome.error, consecutive_failures_at_least: 3 },
      });
    }
  }

  const sources = [...outcomes.values()];
  const outcome: FetchOutcome = sources.every((s) => s.status === 'ok') ? 'ok' : sources.every((s) => s.status === 'failed') ? 'failed' : 'partial';
  const endedAt = deps.now().toISOString();
  const fetchRunId = dryRun ? null : insertFetchRun(db, { assetId: asset.id, startedAt, endedAt, outcome, detail: { sources } });
  return { assetId: asset.id, dryRun, fetchRunId, outcome, startedAt, endedAt, sources, written, anomalies };
}
