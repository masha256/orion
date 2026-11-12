import { lockHolder, withRunLock } from '../../app/lock.js';
import { fetchSummary } from '../../cli/util.js';
import { loadAsset } from '../../config/load.js';
import type { AssetConfig } from '../../config/schema.js';
import { dbDayBlocks } from '../../db/dayBlocks.js';
import { listJobs, type BackfillParams } from '../../db/jobs.js';
import { realFetchDeps } from '../../ingest/deps.js';
import { fetchAsset, type FetchDeps, type FetchResult } from '../../ingest/run.js';
import { sourceId } from '../../ingest/sourceId.js';
import { slackClean } from '../../notify/format.js';
import { OrionError } from '../../types.js';
import type { JobContext, JobHandler, JobOutcome } from '../daemon.js';
import { loadSchedule, newestSlot, nextSlot } from '../schedule.js';
import { REFRESH_LOCKED_RETRY_MS } from './refresh.js';

/** A backfill does not start when the env's next nightly slot is closer than this (plan P1)... */
export const BACKFILL_CLEARANCE_MS = 4 * 3_600_000;
/** ...nor before this long after a nightly slot began: it then waits until that slot + this. */
export const BACKFILL_DEFER_AFTER_MS = 2 * 3_600_000;
/**
 * ...and, past that, while a `refresh` or the `nightly_report` of the newest nightly slot is still queued or running
 * (a retry 10/30 min later, a report waiting up to slot + 3 h): it then looks again this much later.
 */
export const BACKFILL_NIGHTLY_RECHECK_MS = 15 * 60_000;
/** The most days one backfill re-scans. */
export const BACKFILL_MAX_DAYS = 400;

export interface BackfillJobResult {
  /** The fetch's summary lines (what `orion data fetch` prints); empty when nothing was fetched. */
  fetchLines: string[];
  /** Rows written per requested metric; empty when nothing was fetched. */
  written: Record<string, number>;
}

export interface BackfillHandlerOptions {
  /** The transports. Default: the real ones, on the job's re-read env, plus the day-boundary block cache. */
  fetchDeps?: (ctx: JobContext) => FetchDeps;
  /** The fetch (a test seam). Default: `fetchAsset`. */
  fetch?: typeof fetchAsset;
}

function invalid(message: string): never {
  throw new OrionError('invalid_backfill_params', message);
}

/**
 * A backfill request checked against the asset's config: `{ op: 'fetch', metrics, backfillDays }` and nothing else;
 * each metric configured, a flow, and read from a source (a flow entered by hand has nothing to re-scan), none twice;
 * `backfillDays` a whole number in 1..BACKFILL_MAX_DAYS. Throws `invalid_backfill_params`. The CLI runs the same check
 * before queueing, so a bad request never reaches the queue; the handler runs it again on the release that runs it.
 */
export function parseBackfillParams(raw: unknown, asset: AssetConfig): BackfillParams {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) invalid('a backfill job needs params { op, metrics, backfillDays }');
  const p = raw as Record<string, unknown>;
  const extra = Object.keys(p).filter((k) => !['op', 'metrics', 'backfillDays'].includes(k));
  if (extra.length > 0) invalid(`unknown param ${extra.map((k) => `"${k}"`).join(', ')}`);
  if (p.op !== 'fetch') invalid(`op must be "fetch", got ${JSON.stringify(p.op ?? null)}`);
  const metrics = p.metrics;
  if (!Array.isArray(metrics) || metrics.length === 0 || !metrics.every((m) => typeof m === 'string' && m !== '')) {
    invalid('metrics must be a non-empty list of metric keys');
  }
  const keys = metrics as string[];
  const twice = keys.find((m, i) => keys.indexOf(m) !== i);
  if (twice !== undefined) invalid(`metric "${twice}" is listed twice`);
  for (const key of keys) {
    const def = asset.metrics[key];
    if (!def) invalid(`metric "${key}" is not defined in assets/${asset.id}.yaml`);
    if (def.type !== 'flow') invalid(`metric "${key}" is a ${def.type}, not a flow: only flows are backfilled`);
    if (!def.source) invalid(`metric "${key}" has no source; it is entered by hand, there is nothing to re-scan`);
  }
  const days = p.backfillDays;
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > BACKFILL_MAX_DAYS) {
    invalid(`backfillDays must be a whole number from 1 to ${BACKFILL_MAX_DAYS}, got ${JSON.stringify(days ?? null)}`);
  }
  return { op: 'fetch', metrics: [...keys], backfillDays: days };
}

/**
 * Null when a backfill may start at `now`; otherwise the epoch ms it should wait until. The window from
 * BACKFILL_CLEARANCE_MS before each of the env's nightly slots to BACKFILL_DEFER_AFTER_MS after it is closed, so a
 * multi-hour re-scan on the daemon's one worker never holds up the nightly's refreshes. Past that window it also waits,
 * BACKFILL_NIGHTLY_RECHECK_MS at a time, while any `refresh` or `nightly_report` job of the newest nightly slot is
 * unfinished (queued, a queued retry included, or running): the clock alone can't know the nightly is done. An env
 * without a nightly entry has no closed window.
 */
export async function backfillWaitUntil(ctx: JobContext, now: Date): Promise<number | null> {
  const nightly = loadSchedule(ctx.paths.configRoot, ctx.env).find((e) => e.key === 'nightly');
  if (!nightly) return null;
  const t = now.getTime();
  const last = newestSlot(nightly.cadence, now);
  if (t < last.getTime() + BACKFILL_DEFER_AFTER_MS) return last.getTime() + BACKFILL_DEFER_AFTER_MS;
  const next = nextSlot(nightly.cadence, now).getTime();
  if (next - t < BACKFILL_CLEARANCE_MS) return next + BACKFILL_DEFER_AFTER_MS;
  const ofSlot = await listJobs(ctx.db, { slot: last.toISOString(), limit: 100_000 });
  const unfinished = ofSlot.some((j) => (j.kind === 'refresh' || j.kind === 'nightly_report') && (j.status === 'queued' || j.status === 'running'));
  if (unfinished) return t + BACKFILL_NIGHTLY_RECHECK_MS;
  return null;
}

/** `65 min` -> `1 h 05 min`; whole minutes, rounded. */
export function fmtDuration(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const aborted: JobOutcome = { status: 'failed', result: null, error: 'aborted: the lease was lost' };

/** `<code>: <message>` of a failure, first line only. */
function codeOf(err: unknown): { code: string; message: string } {
  if (err instanceof OrionError) return { code: err.code, message: err.message.split('\n')[0]! };
  return { code: err instanceof Error ? err.constructor.name : 'error', message: message(err).split('\n')[0]! };
}

/**
 * A fetch that did not do what was asked: every source failed (`fetch_failed`), or a failed source is the primary of a
 * requested metric (`fetch_partial`); the first such source's error, first line. Null when it did, which includes a
 * partial fetch whose only failed sources are cross-checks (the rows were written; the done line names them).
 */
function fetchFailure(r: FetchResult, primaries: Set<string>): { code: string; message: string } | null {
  const line = (s: FetchResult['sources'][number]) => `${s.sourceId}: ${(s.error ?? 'failed').split('\n')[0]}`;
  if (r.outcome === 'failed') {
    const s = r.sources.find((x) => x.status === 'failed');
    return { code: 'fetch_failed', message: s ? line(s) : 'nothing was fetched' };
  }
  const s = r.sources.find((x) => x.status === 'failed' && primaries.has(x.sourceId));
  return s ? { code: 'fetch_partial', message: line(s) } : null;
}

/**
 * The `backfill` job (plan P1): `orion data fetch <asset> --metric ... --backfill-days N` run by the daemon, under the
 * asset's run lock, so a remote operator queues it (`orion job run-now backfill`) instead of holding an SSH session
 * for hours. Never retried (max attempts 1): a failure posts one ALERT line naming the asset, the metrics and the
 * error, and the operator decides. Deferred, without using its attempt, while the env's nightly is near or running
 * (`backfillWaitUntil`) and, for REFRESH_LOCKED_RETRY_MS, while another run holds the asset's lock. The asset needs no
 * registry state: a backfill is an operator action. A start line is posted once the lock is held (a backfill must be
 * sized to finish inside the 4 h clearance; nothing bounds it in code); done posts the rows written per metric and the
 * run's duration, and a failure after the start says how long it ran. A requested metric whose primary source failed
 * fails the job; a failed cross-check alone leaves it done, named in the line.
 */
export function makeBackfillHandler(o: BackfillHandlerOptions = {}): JobHandler {
  const fetch = o.fetch ?? fetchAsset;
  return async (job, ctx) => {
    if (ctx.signal.aborted) return aborted;
    const assetId = job.assetId;
    if (assetId === null) return { status: 'failed', result: null, error: 'a backfill job needs an asset' };
    const result: BackfillJobResult = { fetchLines: [], written: {} };
    let symbol = assetId.toUpperCase();
    let params: BackfillParams | null = null;
    let failure: { code: string; message: string };
    const run: { startedMs: number | null } = { startedMs: null };
    try {
      const loaded = loadAsset(ctx.paths.configRoot, assetId);
      symbol = loaded.config.symbol;
      params = parseBackfillParams(job.params, loaded.config);
      const now = ctx.clock.now();
      const until = await backfillWaitUntil(ctx, now);
      if (until !== null) return { status: 'deferred', untilMs: until };
      const base = o.fetchDeps ? o.fetchDeps(ctx) : realFetchDeps(ctx.envVars, () => ctx.clock.now());
      const deps: FetchDeps = { ...base, dayBlocks: (chainId) => dbDayBlocks(ctx.db, chainId) };
      const { metrics, backfillDays } = params;
      ctx.log(`backfill ${assetId} ${metrics.join(', ')} ${backfillDays} days`);
      const fetched = await withRunLock(ctx.db, assetId, lockHolder('daemon backfill'), now, async () => {
        run.startedMs = ctx.clock.now().getTime();
        const start = `ORION BACKFILL ${ctx.env} ${symbol} started: ${metrics.join(', ')}, ${backfillDays} days`;
        const sent = await ctx.notify.post(slackClean(start, 1000));
        if (!sent.ok) ctx.log(`backfill start line not delivered: ${sent.error ?? 'unknown error'}`);
        return await fetch(ctx.db, loaded, now, deps, { metrics, backfillDays, onProgress: (line) => ctx.log(line) });
      });
      if (ctx.signal.aborted) return aborted;
      result.fetchLines = fetchSummary(fetched);
      for (const m of metrics) result.written[m] = fetched.written.filter((w) => w.metricKey === m).length;
      const primaries = new Set(metrics.map((m) => sourceId(loaded.config.metrics[m]!.source!)));
      const failed = fetchFailure(fetched, primaries);
      if (!failed) {
        const partial = fetched.outcome === 'partial'
          ? `; partial: ${fetched.sources.filter((s) => s.status === 'failed').map((s) => s.sourceId).join(', ')} failed`
          : '';
        const rows = metrics.map((m) => `${m} ${result.written[m]} rows`).join(', ');
        const took = fmtDuration(ctx.clock.now().getTime() - run.startedMs!);
        const text = `ORION BACKFILL ${ctx.env} ${symbol} done in ${took} (${backfillDays} days): ${rows}${partial}`;
        const posted = await ctx.notify.post(slackClean(text, 1000));
        if (!posted.ok) ctx.log(`backfill line not delivered: ${posted.error ?? 'unknown error'}`);
        return { status: 'done', result };
      }
      failure = failed;
    } catch (err) {
      if (ctx.signal.aborted) return aborted;
      if (err instanceof OrionError && err.code === 'run_in_progress') {
        ctx.log(`${err.message}; deferred`);
        return { status: 'deferred', untilMs: ctx.clock.now().getTime() + REFRESH_LOCKED_RETRY_MS };
      }
      failure = codeOf(err);
    }
    if (ctx.signal.aborted) return aborted;
    const what = params ? ` ${slackClean(params.metrics.join(', '), 400)}` : '';
    const after = run.startedMs !== null ? ` after ${fmtDuration(ctx.clock.now().getTime() - run.startedMs)}` : '';
    const text = `ORION ALERT ${ctx.env} backfill ${symbol}${what} failed${after}: ${slackClean(failure.code, 60)}: ${slackClean(failure.message)}`;
    const posted = await ctx.notify.post(text);
    if (!posted.ok) ctx.log(`alert not delivered: ${posted.error ?? 'unknown error'}`);
    return { status: 'failed', result, error: `${failure.code}: ${failure.message}` };
  };
}

/** The daemon's backfill job. */
export const backfillHandler: JobHandler = makeBackfillHandler();
