import type { LoadedAsset } from '../config/load.js';
import type { AssetConfig } from '../config/schema.js';
import { isChainSource } from '../config/sources.js';
import type { Db } from '../db/connection.js';
import { upsertLatestLevels, type LatestLevel } from '../db/latestLevels.js';
import { getAdapter } from '../ingest/adapters/registry.js';
import { buildPlan } from '../ingest/plan.js';
import { fetchAsset, type FetchDeps } from '../ingest/run.js';
import { coingeckoBase, coingeckoHeaders } from '../ingest/sources/coingecko.js';
import type { HttpTransport } from '../ingest/transport/http.js';
import type { BlockRef, RpcFactory } from '../ingest/transport/rpc.js';
import type { WrittenObservation } from '../ingest/types.js';
import { locatorOfSource, scrubLocator } from '../provenance/locator.js';
import { sourceTypeOf } from '../report/sourceTypes.js';
import type { WatchFiring } from '../types.js';

/** CoinGecko takes at most this many ids in one /coins/markets call. */
export const MARKETS_BATCH = 250;

export interface LevelsResult {
  perAsset: { assetId: string; ok: string[]; failed: { sourceId: string; error: string }[]; firings: WatchFiring[] }[];
  rows: LatestLevel[];
}

/**
 * The metrics the hourly job reads: level and schedule metrics with a source that is read (not derived, not a constant),
 * and, among monitor-only ones, only the watched (display data nobody watches waits for the nightly). Sorted.
 */
export function levelMetricKeys(asset: AssetConfig): string[] {
  return Object.entries(asset.metrics)
    .filter(([, d]) => (d.type === 'level' || d.type === 'schedule') && d.source !== undefined && d.source.type !== 'derived' && d.source.type !== 'constant')
    .filter(([, d]) => d.monitor_only !== true || d.watch !== undefined)
    .map(([k]) => k)
    .sort();
}

/** The CoinGecko ids an asset's hourly read asks /coins/markets for (primaries and cross-checks). */
function coingeckoIds(asset: AssetConfig, metrics: string[]): string[] {
  return buildPlan(asset, { metrics })
    .batches.flatMap((b) => b.requests)
    .flatMap((r) => (r.source.type === 'coingecko' ? [r.source.id] : []));
}

/** One `/coins/markets` call per 250 ids (sorted, deduplicated): the market rows by id. No ids, no call. */
export async function prefetchMarkets(http: HttpTransport, env: Record<string, string | undefined>, ids: string[]): Promise<Map<string, Record<string, unknown>>> {
  const sorted = [...new Set(ids)].sort();
  const rows = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < sorted.length; i += MARKETS_BATCH) {
    const chunk = sorted.slice(i, i + MARKETS_BATCH);
    const body = await http.getJson(`${coingeckoBase(env)}/coins/markets?vs_currency=usd&ids=${chunk.map(encodeURIComponent).join(',')}`, coingeckoHeaders(env));
    if (!Array.isArray(body)) throw new Error('coingecko: /coins/markets did not return an array');
    for (const row of body) {
      if (row !== null && typeof row === 'object' && typeof (row as { id?: unknown }).id === 'string') rows.set((row as { id: string }).id, row as Record<string, unknown>);
    }
  }
  return rows;
}

const isMarketsRead = (url: URL): boolean => url.hostname.endsWith('coingecko.com') && url.pathname.endsWith('/coins/markets') && url.searchParams.has('ids');

/**
 * Answers every CoinGecko `/coins/markets?...ids=` GET from `rows` (the rows of the requested ids it has, in the
 * requested order); every other request passes through. `rows` an Error: the batched call failed, and each markets read
 * fails with it.
 */
export function withPrefetchedMarkets(http: HttpTransport, rows: Map<string, Record<string, unknown>> | Error): HttpTransport {
  return {
    ...http,
    getJson: async (url, headers) => {
      const u = new URL(url);
      if (!isMarketsRead(u)) return await http.getJson(url, headers);
      if (rows instanceof Error) throw rows;
      return u.searchParams.get('ids')!.split(',').flatMap((id) => {
        const row = rows.get(id);
        return row === undefined ? [] : [structuredClone(row)];
      });
    },
  };
}

function readsChain(asset: AssetConfig, metricKey: string): boolean {
  const s = asset.metrics[metricKey]?.source;
  return s !== undefined && (isChainSource(s) || (s.type === 'adapter' && getAdapter(s.name).needsRpc));
}

/** One row per metric read: a level's reading; for a schedule, its newest step at or before `now` (none: no row). */
/** A level's rung and scrubbed locator, from the asset config (the same mapping the observation writers use). */
function levelProvenance(asset: AssetConfig, metricKey: string): Pick<LatestLevel, 'sourceType' | 'locator'> {
  const def = asset.metrics[metricKey];
  if (def?.source === undefined) return { sourceType: null, locator: null };
  return { sourceType: sourceTypeOf(def, asset.metrics), locator: scrubLocator(locatorOfSource(asset, metricKey, def.source)) };
}

export function toLatestLevels(asset: AssetConfig, written: WrittenObservation[], now: Date, jobId: number | null, block: BlockRef | null): LatestLevel[] {
  const byMetric = new Map<string, WrittenObservation>();
  for (const w of written) {
    const def = asset.metrics[w.metricKey];
    if (def === undefined || (def.type !== 'level' && def.type !== 'schedule')) continue;
    if (def.type === 'schedule' && Date.parse(w.observedAt) > now.getTime()) continue;
    const have = byMetric.get(w.metricKey);
    if (have === undefined || Date.parse(w.observedAt) >= Date.parse(have.observedAt)) byMetric.set(w.metricKey, w);
  }
  return [...byMetric.values()]
    .sort((a, b) => (a.metricKey < b.metricKey ? -1 : a.metricKey > b.metricKey ? 1 : 0))
    .map((w) => ({
      assetId: asset.id, metricKey: w.metricKey, value: w.value, observedAt: new Date(w.observedAt).toISOString(), source: w.source,
      blockNumber: block !== null && readsChain(asset, w.metricKey) ? Number(block.number) : null, jobId,
      ...levelProvenance(asset, w.metricKey),
    }));
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The hourly read (spec 5.4): each asset's level metrics through fetchAsset as a dry run, with every CoinGecko markets
 * read answered from one batched call, written to `latest_levels` only (never observations, fetch_runs or anomalies).
 * An asset whose fetch throws is listed failed (source `*`) and the others continue. `signal`: stop between assets.
 */
export async function runLevels(db: Db, assets: LoadedAsset[], deps: FetchDeps, now: Date, jobId: number, opts: { signal?: AbortSignal } = {}): Promise<LevelsResult> {
  const keys = new Map(assets.map((a) => [a.config.id, levelMetricKeys(a.config)]));
  const ids: string[] = [];
  for (const a of assets) {
    const metrics = keys.get(a.config.id)!;
    if (metrics.length === 0) continue;
    try {
      ids.push(...coingeckoIds(a.config, metrics));
    } catch {
      // a configuration error: the asset's own fetch below reports it
    }
  }
  let markets: Map<string, Record<string, unknown>> | Error;
  try {
    markets = await prefetchMarkets(deps.http, deps.env, ids);
  } catch (err) {
    markets = err instanceof Error ? err : new Error(String(err));
  }
  const http = withPrefetchedMarkets(deps.http, markets);

  const result: LevelsResult = { perAsset: [], rows: [] };
  for (const a of assets) {
    if (opts.signal?.aborted) break;
    const entry: LevelsResult['perAsset'][number] = { assetId: a.config.id, ok: [], failed: [], firings: [] };
    result.perAsset.push(entry);
    const metrics = keys.get(a.config.id)!;
    if (metrics.length === 0) continue;
    // The block the chain reads were made at, for the rows' block_number.
    let block: BlockRef | null = null;
    const rpcFactory: RpcFactory = (url, chainId) => {
      const rpc = deps.rpcFactory(url, chainId);
      return { ...rpc, latestBlock: async () => (block = await rpc.latestBlock()) };
    };
    try {
      const r = await fetchAsset(db, a, now, { ...deps, http, rpcFactory }, { metrics, dryRun: true });
      const rows = toLatestLevels(a.config, r.written, now, jobId, block);
      await upsertLatestLevels(db, rows);
      result.rows.push(...rows);
      entry.ok = rows.map((l) => l.metricKey);
      entry.failed = r.sources.filter((s) => s.status === 'failed').map((s) => ({ sourceId: s.sourceId, error: s.error ?? 'failed' }));
      entry.firings = r.watch.filter((f) => f.rule !== 'above');
    } catch (err) {
      entry.failed = [{ sourceId: '*', error: message(err) }];
    }
  }
  return result;
}
