import type { LoadedAsset } from '../config/load.js';
import { revenueStaleMovePct, type MetricDef } from '../config/schema.js';
import { isChainSource } from '../config/sources.js';
import { findStandingAnomaly, raiseAnomaly } from '../db/anomalies.js';
import type { Db } from '../db/connection.js';
import { emptySourceOutcome, insertFetchRun, recentSourceStatuses, type FetchOutcome, type SourceOutcome } from '../db/fetchRuns.js';
import { insertObservation, listActiveObservations } from '../db/observations.js';
import { latestLevel } from '../drivers/select.js';
import { MS_PER_DAY, OrionError, STD_METRICS } from '../types.js';
import { getAdapter } from './adapters/registry.js';
import { checkRevenueStale, type IndexPoint } from './alerts.js';
import { DEFAULT_API_FLOW_BACKFILL_DAYS, writeApiFlow } from './apiFlow.js';
import { compareLevel, compareMonthly } from './crosscheck.js';
import { derivedFunction, type DerivedName } from './derived.js';
import { scanFlowGroup } from './flow.js';
import { buildPlan, hasSources, type FlowGroup, type SourceBatch } from './plan.js';
import { sourceId } from './sourceId.js';
import { getSourceHandler } from './sources/registry.js';
import { monthOf, utcDay } from './time.js';
import { withRunCache, type HttpTransport } from './transport/http.js';
import type { BlockRef, RpcFactory, RpcTransport } from './transport/rpc.js';
import {
  contractResolver, failed, type DailyPoint, type RaisedAnomaly, type ReadingResult, type SourceContext, type SourceRequest, type WrittenObservation,
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

/** An unlisted sender degrades the group's critical metrics; with none critical, its first metric. */
function unlistedAnomalyMetrics(loaded: LoadedAsset, group: FlowGroup): string[] {
  const critical = group.members.map((m) => m.metricKey).filter((k) => loaded.config.metrics[k].critical);
  return critical.length > 0 ? critical : [group.members[0].metricKey];
}

/** The metric's stored daily fetched rows (a transfer scan's or an API series'), keyed by the UTC day each one covers. */
function storedDailyFlow(db: Db, assetId: string, metricKey: string): Map<string, number> {
  const days = new Map<string, number>();
  for (const o of listActiveObservations(db, assetId, metricKey)) {
    if ((o.source === 'onchain' || o.source === 'api') && o.periodDays === 1) days.set(utcDay(new Date(o.observedAt).getTime() - MS_PER_DAY), o.value);
  }
  return days;
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
  const raise = (a: Omit<RaisedAnomaly, 'id' | 'status'>): void => {
    if (dryRun) {
      // Nothing is written; report what a real run would do: an acknowledged condition stays acknowledged.
      const standing = findStandingAnomaly(db, { assetId: asset.id, ...a });
      anomalies.push({ id: null, status: standing?.status === 'acknowledged' ? 'acknowledged' : 'open', ...a });
      return;
    }
    const row = raiseAnomaly(db, { assetId: asset.id, ...a, seenAt: startedAt });
    anomalies.push({ id: row.id, status: row.status === 'acknowledged' ? 'acknowledged' : 'open', ...a });
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

  // 2. Primaries: validate, then write through insertObservation with the source's own timestamp. A flow whose primary
  //    is an API's daily series (defillama) is written as daily rows under a cursor, like a transfer scan.
  const primaryValue = new Map<string, number>();
  const scannedDaily = new Map<string, DailyPoint[]>();
  for (const batch of plan.batches) {
    for (const r of batch.requests) {
      if (r.role !== 'primary') continue;
      const outcome = outcomeOf(batch.sourceId);
      const result = readings.get(r)!;
      if (!result.ok) {
        markFailed(outcome, `${r.metricKey}: ${result.error}`);
        continue;
      }
      if (result.value.kind === 'daily_series' && r.source.type === 'defillama' && asset.metrics[r.metricKey].type === 'flow') {
        const def = asset.metrics[r.metricKey];
        try {
          const flow = writeApiFlow({
            db, asset, metricKey: r.metricKey, scanKey: `${batch.sourceId}>${r.metricKey}`, points: result.value.points, detail: result.value.detail, now,
            backfillDays: opts.backfillDays ?? r.source.backfill_days ?? DEFAULT_API_FLOW_BACKFILL_DAYS, rescan: opts.backfillDays !== undefined,
            adopt: opts.adopt ?? false, dryRun, outcome, validate: (value) => validateReading(def, value),
          });
          written.push(...flow.written);
          scannedDaily.set(r.metricKey, flow.daily);
        } catch (err) {
          if (err instanceof OrionError) throw err;
          markFailed(outcome, `${r.metricKey}: ${message(err)}`);
        }
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

  // 4. Transfer scans: one per flow group, at the same latest block as the level reads.
  for (const group of plan.flowGroups) {
    if (rpc === null || block === null) {
      markFailed(outcomeOf(group.sourceId), chainError ?? 'no RPC connection');
      continue;
    }
    const scan = await scanFlowGroup({
      db, asset, group, rpc, latest: block, http: ctx.http, env: deps.env, sleep: deps.sleep, now,
      backfillDays: opts.backfillDays ?? asset.ingest!.backfill_days, rescan: opts.backfillDays !== undefined,
      adopt: opts.adopt ?? false, dryRun, onProgress: opts.onProgress,
    });
    outcomes.set(group.sourceId, scan.outcome);
    written.push(...scan.written);
    for (const [metricKey, points] of scan.daily) scannedDaily.set(metricKey, points);

    const bySender = new Map<string, typeof scan.unlisted>();
    for (const t of scan.unlisted) bySender.set(t.from, [...(bySender.get(t.from) ?? []), t]);
    for (const [sender, transfers] of bySender) {
      const first = transfers[0];
      const last = transfers[transfers.length - 1];
      for (const metricKey of unlistedAnomalyMetrics(loaded, group)) {
        raise({
          kind: 'unlisted_sender', metricKey, dedupeKey: sender, severity: 'degrading',
          detail: {
            sender, transfers: transfers.length, tokens: transfers.reduce((s, t) => s + t.tokens, 0),
            first: { tx: first.txHash, day: first.day }, last: { tx: last.txHash, day: last.day }, scan: group.sourceId,
          },
        });
      }
    }
  }

  // 5. Monthly cross-checks of flow metrics: stored daily rows, with this run's days laid over them.
  const currentMonth = monthOf(utcDay(now.getTime()));
  for (const batch of plan.batches) {
    for (const r of batch.requests) {
      const def = asset.metrics[r.metricKey];
      if (r.role !== 'cross_check' || def.type !== 'flow') continue;
      const outcome = outcomeOf(batch.sourceId);
      const result = readings.get(r)!;
      if (!result.ok) {
        markFailed(outcome, `${r.metricKey}: ${result.error}`);
        continue;
      }
      if (result.value.kind === 'level') {
        markFailed(outcome, `${r.metricKey}: expected a daily or monthly series, got a level`);
        continue;
      }
      const days = storedDailyFlow(db, asset.id, r.metricKey);
      for (const p of scannedDaily.get(r.metricKey) ?? []) days.set(p.day, p.value);
      const primary = [...days.entries()].map(([day, value]) => ({ day, value }));
      const months = compareMonthly(primary, result.value, r.tolerancePct, currentMonth);
      if (months.length === 0) outcome.notes.push(`${r.metricKey}: no calendar month is fully covered by both series yet`);
      for (const m of months) {
        outcome.crossChecks.push({
          metricKey: r.metricKey, sourceId: batch.sourceId, label: m.month, primary: m.primary, check: m.check, diffPct: m.diffPct,
          tolerancePct: r.tolerancePct, ok: m.ok,
        });
      }
      const bad = months.filter((m) => !m.ok);
      if (bad.length > 0) {
        raise({
          kind: 'cross_check_mismatch', metricKey: r.metricKey, dedupeKey: batch.sourceId, severity: def.critical ? 'degrading' : 'advisory',
          detail: {
            months: bad.map((m) => ({ month: m.month, primary: m.primary, check: m.check, diff_pct: m.diffPct })),
            tolerance_pct: r.tolerancePct, primary_source: sourceId(def.source!), check_source: batch.sourceId,
          },
        });
      }
    }
  }

  // 6. Derived metrics, from stored observations plus this run's days (so a dry run sees them too).
  const derivedIndex: IndexPoint[] = [];
  for (const r of plan.derived) {
    if (r.source.type !== 'derived') continue;
    const outcome = outcomeOf(sourceId(r.source));
    const name = r.source.name as DerivedName; // buildPlan refused any other name
    const flowMetric = r.source.params.metric;
    const windowDays = r.source.params.days ?? 30;
    if (typeof flowMetric !== 'string' || asset.metrics[flowMetric]?.type !== 'flow') {
      throw new OrionError('invalid_source_config', `metrics.${r.metricKey}: ${name} needs "metric" to name a flow metric`);
    }
    if (typeof windowDays !== 'number' || !Number.isInteger(windowDays) || windowDays < 1) {
      throw new OrionError('invalid_source_config', `metrics.${r.metricKey}: ${name} "days" must be a positive integer`);
    }
    // A derivation carries the provenance of its input: an API series' flow gives an api level, a transfer scan's an onchain one.
    const provenance: 'onchain' | 'api' = asset.metrics[flowMetric].source?.type === 'defillama' ? 'api' : 'onchain';
    const days = storedDailyFlow(db, asset.id, flowMetric);
    for (const p of scannedDaily.get(flowMetric) ?? []) days.set(p.day, p.value);
    // Keyed by observedAt: a re-scan (--backfill-days) can change a stored day's value, which changes
    // every index window that covers it. Skip only when the existing row already has this value; a
    // changed value must be rewritten (insertObservation supersedes the row at the same observedAt).
    const have = new Map(listActiveObservations(db, asset.id, r.metricKey).map((o) => [o.observedAt, o.value]));
    let wrote = 0;
    for (const point of derivedFunction(name)(days, windowDays)) {
      const observedAt = new Date(new Date(`${point.day}T00:00:00.000Z`).getTime() + MS_PER_DAY).toISOString(); // the day's period end
      if (have.get(observedAt) === point.value) continue;
      const observationId = dryRun
        ? null
        : insertObservation(db, {
            assetId: asset.id, metricKey: r.metricKey, observedAt, value: point.value, source: provenance,
            sourceDetail: `derived ${name}(${flowMetric}, ${windowDays}d)`, fetchedAt: startedAt,
          }).id;
      written.push({ metricKey: r.metricKey, value: point.value, observedAt, periodDays: null, source: provenance, observationId });
      if (r.metricKey === STD_METRICS.usageIndex) derivedIndex.push({ observedAt, value: point.value });
      wrote++;
    }
    if (wrote > 0) outcome.metricsWritten.push(r.metricKey);
    else outcome.notes.push(`${r.metricKey}: no new day with ${windowDays} complete days behind it`);
  }

  // 7. The stale-revenue alert: advisory, and only for assets that define a usage index.
  const revenueDef = asset.metrics[STD_METRICS.revenue];
  if (asset.metrics[STD_METRICS.usageIndex] !== undefined && revenueDef !== undefined) {
    const usable = listActiveObservations(db, asset.id, STD_METRICS.revenue).filter((o) => o.status === 'confirmed' || revenueDef.allow_provisional);
    const revenue = latestLevel(usable, startedAt);
    if (revenue) {
      const stored = listActiveObservations(db, asset.id, STD_METRICS.usageIndex).map((o) => ({ observedAt: o.observedAt, value: o.value }));
      const index = dryRun ? [...stored, ...derivedIndex] : stored; // a real run has already stored them
      const finding = checkRevenueStale(revenue.observedAt, index, revenueStaleMovePct(asset));
      if (finding) {
        raise({ kind: 'revenue_disclosure_stale', metricKey: STD_METRICS.revenue, dedupeKey: revenue.observedAt, severity: 'advisory', detail: finding.detail });
      }
    }
  }

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
