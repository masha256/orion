import { tickAsset, type TickDeps, type TickResult } from '../../app/tick.js';
import type { TickReport } from '../../app/tickReport.js';
import { fetchSummary } from '../../cli/util.js';
import { loadAsset, type LoadedAsset } from '../../config/load.js';
import type { OrionDb } from '../../db/connection.js';
import { dbDayBlocks } from '../../db/dayBlocks.js';
import type { Job } from '../../db/jobs.js';
import { upsertLatestLevels } from '../../db/latestLevels.js';
import { getRegistryRow, recordRun } from '../../db/registry.js';
import { listWatchStates, putWatchStates } from '../../db/watchState.js';
import { realFetchDeps } from '../../ingest/deps.js';
import type { FetchDeps, FetchResult } from '../../ingest/run.js';
import type { BlockRef, RpcFactory } from '../../ingest/transport/rpc.js';
import { levelMetricKeys, toLatestLevels } from '../../levels/levels.js';
import { levelWatchRule, watchTransitions } from '../../levels/watchTransitions.js';
import { slackClean } from '../../notify/format.js';
import { OrionError, type WatchRule } from '../../types.js';
import type { JobContext, JobHandler, JobOutcome } from '../daemon.js';

/** A failed tick (exit 1, or a throw) is retried this long after the failure. */
export const REFRESH_RETRY_MS = 600_000;
/** The asset's run lock was held by another run (`run_in_progress`): retried this long after. */
export const REFRESH_LOCKED_RETRY_MS = 1_800_000;

/** The fetch lines the nightly report quotes when an asset's block is an alert. */
const ALERT_LINE = /OUTSIDE|conflict|unlisted sender/;

export interface RefreshJobResult {
  /** Null only when the tick threw (a bug): there is no report. */
  report: TickReport | null;
  /** The fetch's summary lines (what `orion tick` prints on stderr). */
  fetchLines: string[];
  /** The fetch lines carrying `OUTSIDE`, `conflict` or `unlisted sender`. */
  alertFlags: string[];
  /** Rows written to `latest_levels` from the fetch's level readings. */
  levels: number;
  /** On a failed attempt: whether the double-failure ALERT was posted (the last attempt only). */
  alerted?: boolean;
}

export interface RefreshHandlerOptions {
  /** The transports. Default: the real ones, on the job's re-read env. The day-block cache and the slot's chart cache are added. */
  fetchDeps?: (ctx: JobContext) => FetchDeps;
  /** The tick (a test seam). Default: `tickAsset`. */
  tick?: (db: OrionDb, loaded: LoadedAsset, deps: TickDeps) => Promise<TickResult>;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const aborted: JobOutcome = { status: 'failed', result: null, error: 'aborted: the lease was lost' };

/** `<code>: <message>` of a failure, first line only. */
function codeOf(err: unknown): { code: string; message: string } {
  if (err instanceof OrionError) return { code: err.code, message: err.message.split('\n')[0]! };
  return { code: err instanceof Error ? err.constructor.name : 'error', message: message(err).split('\n')[0]! };
}

/**
 * The fetch's level and schedule readings into `latest_levels` (the hourly job's rows, so a nightly reading is never
 * older than the table), and the level watches' state into `watch_state` (no post: the nightly report lists what
 * fires). Flow (`above`) rules are not tracked here. How many rows were written.
 */
async function keepLevels(ctx: JobContext, job: Job, loaded: LoadedAsset, fetch: FetchResult, block: BlockRef | null): Promise<number> {
  const asset = loaded.config;
  const keys = new Set(levelMetricKeys(asset));
  const now = ctx.clock.now();
  const rows = toLatestLevels(asset, fetch.written.filter((w) => keys.has(w.metricKey)), now, job.id, block);
  await upsertLatestLevels(ctx.db, rows);
  const evaluated = rows.flatMap((r) => {
    const rule: WatchRule | null = levelWatchRule(asset.metrics[r.metricKey]);
    return rule === null ? [] : [{ metricKey: r.metricKey, rule, value: r.value }];
  });
  if (evaluated.length > 0) {
    const firings = fetch.watch.filter((f) => f.rule !== 'above');
    const t = watchTransitions(await listWatchStates(ctx.db, asset.id), firings, evaluated, now.toISOString(), asset.id);
    await putWatchStates(ctx.db, t.next);
  }
  return rows.length;
}

/**
 * The nightly `refresh` job (spec 5.4): today's `tickAsset` for one active asset, with the day-boundary block cache
 * (N9) and the slot's shared market_chart cache (N8). Exit 0 or 2 is `done` (a report error such as `report_stale` is
 * kept in the result: the report alerts on it); exit 1 is `failed`, retried after 10 min; `run_in_progress` is `failed`,
 * retried after 30 min. The second failure posts `ORION ALERT <env> refresh <SYM> failed twice: <code>: <message>` at
 * once. An asset that is not active when the job runs is `skipped` with its state as the reason.
 */
export function makeRefreshHandler(o: RefreshHandlerOptions = {}): JobHandler {
  const tick = o.tick ?? tickAsset;
  return async (job, ctx) => {
    if (ctx.signal.aborted) return aborted;
    const assetId = job.assetId;
    if (assetId === null) return { status: 'failed', result: null, error: 'a refresh job needs an asset' };
    const row = await getRegistryRow(ctx.db, assetId);
    if (!row || row.state !== 'active') return { status: 'skipped', result: { reason: row?.state ?? 'missing' } };

    const result: RefreshJobResult = { report: null, fetchLines: [], alertFlags: [], levels: 0 };
    let symbol = assetId.toUpperCase();
    let failure: { code: string; message: string; retryAfterMs: number } | null = null;
    try {
      const loaded = loadAsset(ctx.paths.configRoot, assetId);
      symbol = loaded.config.symbol;
      const base = o.fetchDeps ? o.fetchDeps(ctx) : realFetchDeps(ctx.envVars, () => ctx.clock.now());
      // The newest block the fetch read, for the chain-read rows' block_number.
      let block: BlockRef | null = null;
      const rpcFactory: RpcFactory = (url, chainId) => {
        const rpc = base.rpcFactory(url, chainId);
        return { ...rpc, latestBlock: async () => (block = await rpc.latestBlock()) };
      };
      const deps: FetchDeps = {
        ...base, rpcFactory, dayBlocks: (chainId) => dbDayBlocks(ctx.db, chainId), sharedHttpCache: ctx.sharedHttpCache?.(job.slot) ?? base.sharedHttpCache,
      };
      let fetch: FetchResult | null = null;
      const r = await tick(ctx.db, loaded, {
        home: ctx.paths.home, now: () => ctx.clock.now(), fetchDeps: deps, onFetch: (f) => { fetch = f; }, onProgress: (line) => ctx.log(line),
      });
      if (ctx.signal.aborted) return aborted;
      result.report = r.report;
      const fetched = fetch as FetchResult | null;
      if (fetched) {
        result.fetchLines = fetchSummary(fetched);
        result.alertFlags = result.fetchLines.filter((l) => ALERT_LINE.test(l));
        if (!fetched.dryRun) result.levels = await keepLevels(ctx, job, loaded, fetched, block);
      }
      const rep = r.report;
      if (rep.outcome === 'run_in_progress') {
        const holder = rep.lock ? `locked by ${rep.lock.holder} since ${rep.lock.acquired_at}` : 'locked by another run';
        failure = { code: 'run_in_progress', message: holder, retryAfterMs: REFRESH_LOCKED_RETRY_MS };
      } else if (r.exitCode === 1) {
        const e = rep.error ?? { code: 'fetch_failed', message: 'nothing was fetched' };
        failure = { code: e.code, message: e.message, retryAfterMs: REFRESH_RETRY_MS };
      }
    } catch (err) {
      if (ctx.signal.aborted) return aborted;
      const e = codeOf(err);
      failure = { ...e, retryAfterMs: REFRESH_RETRY_MS };
    }

    const now = ctx.clock.now().toISOString();
    if (!failure) {
      const reportError = result.report?.report_error?.code;
      await recordRun(ctx.db, assetId, job.id, now, reportError ? `done (${reportError})` : 'done');
      return { status: 'done', result };
    }
    await recordRun(ctx.db, assetId, job.id, now, `failed: ${failure.code}`);
    const error = `${failure.code}: ${failure.message}`;
    result.alerted = false;
    if (job.attempts >= job.maxAttempts) {
      if (ctx.signal.aborted) return aborted;
      const text = `ORION ALERT ${ctx.env} refresh ${symbol} failed twice: ${slackClean(failure.code, 60)}: ${slackClean(failure.message)}`;
      const posted = await ctx.notify.post(text);
      result.alerted = posted.ok;
      if (!posted.ok) ctx.log(`alert not delivered: ${posted.error ?? 'unknown error'}`);
    }
    return { status: 'failed', result, error, retryAfterMs: failure.retryAfterMs };
  };
}

/** The daemon's refresh job. */
export const refreshHandler: JobHandler = makeRefreshHandler();
