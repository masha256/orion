import type { LoadedAsset } from '../config/load.js';
import type { AssetConfig } from '../config/schema.js';
import { isChainSource } from '../config/sources.js';
import type { Db } from '../db/connection.js';
import { upsertLatestLevels, type LatestLevel } from '../db/latestLevels.js';
import { getAdapter } from '../ingest/adapters/registry.js';
import { buildPlan } from '../ingest/plan.js';
import { MS_PER_HOUR } from '../db/prices.js';
import { fetchAsset, priceWriterOf, type FetchDeps } from '../ingest/run.js';
import { methodSource, type PriceEntry } from '../prices/config.js';
import type { WriteResult } from '../prices/types.js';
import { coingeckoBase, coingeckoHeaders } from '../ingest/sources/coingecko.js';
import type { HttpTransport } from '../ingest/transport/http.js';
import type { BlockRef, RpcFactory } from '../ingest/transport/rpc.js';
import type { WrittenObservation } from '../ingest/types.js';
import { locatorOfSource, scrubLocator } from '../provenance/locator.js';
import { sourceTypeOf } from '../report/sourceTypes.js';
import { OrionError, type WatchFiring } from '../types.js';

/** CoinGecko takes at most this many ids in one /coins/markets call. */
export const MARKETS_BATCH = 250;

export interface LevelsResult {
  perAsset: { assetId: string; ok: string[]; failed: { sourceId: string; error: string }[]; firings: WatchFiring[] }[];
  rows: LatestLevel[];
  /** The chain price write after the level reads (null: no prices.yaml entry, or nothing to write this hour). */
  prices: LevelsPriceWrite | null;
}

/** How far back the hourly job writes a ref's chain prices: the hours since its newest stored hour, at most this many. */
export const LEVELS_PRICE_HOURS = 48;

export interface LevelsPriceWrite {
  fromHourMs: number;
  toHourMs: number;
  /** The writer's result; null when it threw (`error`). */
  result: WriteResult | null;
  error: string | null;
}

/**
 * The hours the hourly job writes (Phase 3 R2 Task 6a): for every ref of prices.yaml, from the hour after its newest row
 * under its primary's source, at most LEVELS_PRICE_HOURS back, up to the top of the current hour (the last completed
 * hour is the newest a row can be written for). One writer run over the earliest such hour: hours already stored are
 * skipped without a read. Null when every ref is up to date.
 */
export async function recentPriceHours(db: Db, prices: ReadonlyMap<string, PriceEntry>, now: Date): Promise<{ fromHourMs: number; toHourMs: number } | null> {
  if (prices.size === 0) return null;
  const toHourMs = Math.floor(now.getTime() / MS_PER_HOUR) * MS_PER_HOUR;
  const floor = toHourMs - LEVELS_PRICE_HOURS * MS_PER_HOUR;
  const newest = await db.all<{ token_ref: string; source: string; ts: string }>(
    'SELECT token_ref, source, max(ts) AS ts FROM prices WHERE token_ref = ANY($1::text[]) AND ts >= $2 GROUP BY token_ref, source',
    [[...prices.keys()], new Date(floor).toISOString()],
  );
  let fromHourMs = toHourMs;
  for (const e of prices.values()) {
    const row = newest.find((r) => r.token_ref === e.ref && r.source === methodSource(e.primary));
    const from = row ? Math.max(floor, new Date(row.ts).getTime() + MS_PER_HOUR) : floor;
    fromHourMs = Math.min(fromHourMs, from);
  }
  return fromHourMs < toHourMs ? { fromHourMs, toHourMs } : null;
}

/** `ORION WATCH <env> price <symbol> <ts>: <gap>% vs <check>`: a price check breach (plan P5; never an anomaly). */
export function formatPriceBreach(env: string, symbol: string, b: WriteResult['breaches'][number]): string {
  return `ORION WATCH ${env} price ${symbol} ${new Date(b.hourMs).toISOString()}: ${b.gapPct >= 0 ? '+' : ''}${b.gapPct.toFixed(2)}% vs ${b.check}`;
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

/**
 * The CoinGecko ids an asset's hourly read asks /coins/markets for (primaries and cross-checks): every coingecko source
 * still configured. Since Phase 3 R2 no flow or burn reads a CoinGecko price; `circulating_supply` stays (R3), and
 * `price_usd` until its sources move to the chain price (Task 6b).
 */
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

/** A level's rung and scrubbed locator, from the asset config (the same mapping the observation writers use). */
function levelProvenance(asset: AssetConfig, metricKey: string): Pick<LatestLevel, 'sourceType' | 'locator'> {
  const def = asset.metrics[metricKey];
  const sourceType = def === undefined ? null : sourceTypeOf(def, asset.metrics);
  // Unreachable for a fetched reading (fetchedProvenance refuses the same cases first); the columns are NOT NULL since 0006.
  if (def?.source === undefined || sourceType === null) throw new OrionError('no_provenance', `metrics.${metricKey}: a level reading needs a configured source with a rung`);
  return { sourceType, locator: scrubLocator(locatorOfSource(asset, metricKey, def.source)) };
}

/** One row per metric read: a level's reading; for a schedule, its newest step at or before `now` (none: no row). */
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
 * Then (Phase 3 R2) the chain prices of every ref in `prices` (prices.yaml) for the hours recentPriceHours names, through
 * the writer (deps.priceWriter, else writeChainPrices); its breaches are the caller's to post.
 */
export async function runLevels(
  db: Db, assets: LoadedAsset[], deps: FetchDeps, now: Date, jobId: number, opts: { signal?: AbortSignal; prices?: ReadonlyMap<string, PriceEntry> } = {},
): Promise<LevelsResult> {
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

  const result: LevelsResult = { perAsset: [], rows: [], prices: null };
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
  if (opts.signal?.aborted || !opts.prices) return result;
  const hours = await recentPriceHours(db, opts.prices, now);
  if (hours === null) return result;
  const write: LevelsPriceWrite = { ...hours, result: null, error: null };
  result.prices = write;
  try {
    write.result = await priceWriterOf(deps, opts.prices)(db, [...opts.prices.keys()].sort(), hours.fromHourMs, hours.toHourMs, opts.signal ? { signal: opts.signal } : {});
  } catch (err) {
    write.error = message(err);
  }
  return result;
}
