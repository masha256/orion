import { lockHolder, withRunLock } from '../../app/lock.js';
import { fetchSummary } from '../../cli/util.js';
import { loadAsset } from '../../config/load.js';
import type { AssetConfig } from '../../config/schema.js';
import { dbDayBlocks } from '../../db/dayBlocks.js';
import { listJobs, saveJobProgress, type BackfillFetchParams, type BackfillPricesParams, type Job } from '../../db/jobs.js';
import { MS_PER_HOUR } from '../../db/prices.js';
import { realFetchDeps } from '../../ingest/deps.js';
import { fetchAsset, type FetchDeps, type FetchResult } from '../../ingest/run.js';
import { sourceId } from '../../ingest/sourceId.js';
import { breachLines, PRICE_WATCH_MAX } from '../../levels/levels.js';
import { slackClean } from '../../notify/format.js';
import { loadPrices, methodSource, type PriceEntry } from '../../prices/config.js';
import type { PriceDeps, WriteResult } from '../../prices/types.js';
import { makePriceDeps, writeChainPrices } from '../../prices/writer.js';
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
/** The most days one op fetch backfill re-scans (backfillDays). */
export const BACKFILL_MAX_DAYS = 400;
/**
 * The most days one prices backfill covers (from..to, both days counted), checked at enqueue only (R27): the full flow
 * history from R2's valid_from (2025-10-13, M4) fits until 2027-04-15.
 */
export const PRICES_BACKFILL_MAX_DAYS = 550;
/**
 * One run of a prices backfill stops after the first chain-day that ends past this much work; the job then defers to
 * now. R28: 10 min, so a deploy's drain (a 30 min wait) waits for the current run's budget, <= 10 min + one chain-day.
 */
export const PRICES_BACKFILL_BUDGET_MS = 10 * 60_000;
/** The most ORION WATCH breach lines one backfill run posts (PRICE_WATCH_MAX, shared with levels and refresh); one summary line counts the rest. */
export const PRICES_BACKFILL_WATCH_MAX = PRICE_WATCH_MAX;
/**
 * The run lock (src/app/lock.ts) a prices backfill holds instead of an asset's (`data purge-prices` holds it too). Not
 * asset-shaped (an asset id is [a-z0-9-]), so no asset's run lock is ever this one.
 */
export const PRICES_LOCK = 'job:prices';

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
  /** Op prices: the price transports. Default: makePriceDeps over the real transports, on the job's re-read env. */
  priceDeps?: (ctx: JobContext, prices: ReadonlyMap<string, PriceEntry>) => PriceDeps;
  /** Op prices: the writer (a test seam). Default: `writeChainPrices`. */
  writer?: typeof writeChainPrices;
  /** Op prices: one run's budget. Default: PRICES_BACKFILL_BUDGET_MS. */
  pricesBudgetMs?: number;
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
export function parseBackfillParams(raw: unknown, asset: AssetConfig): BackfillFetchParams {
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

const DAY_MS = 24 * MS_PER_HOUR;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A `YYYY-MM-DD` calendar day as its 00:00Z epoch ms; anything else (2026-02-30 included) is refused. */
function dayOf(v: unknown, what: string): number {
  const ms = typeof v === 'string' && DAY_RE.test(v) ? Date.parse(`${v}T00:00:00Z`) : NaN;
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== v) invalid(`${what} must be a YYYY-MM-DD day, got ${JSON.stringify(v ?? null)}`);
  return ms;
}

/**
 * A stored prices backfill request (Phase 3 R2 Task 7), the handler's check: `{ op: 'prices', from, to?, refs? }` and
 * nothing else; `from` and `to` calendar days with from <= to; `refs` (absent: every ref of prices.yaml) a non-empty list
 * of prices.yaml refs, none twice. No span cap and no "today" (R27 (b)): the request was checked at enqueue
 * (pricesBackfillRequest), which froze `to`, so a run on a later day never refuses a job mid-rebuild. A job stored without
 * `to` runs to the last completed hour. Throws `invalid_backfill_params`; the handler runs it with the prices.yaml of the
 * release that runs it, so a ref gone from that release fails the job.
 */
export function parsePricesBackfillParams(raw: unknown, prices: ReadonlyMap<string, PriceEntry>): BackfillPricesParams {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) invalid('a prices backfill needs params { op, from, to?, refs? }');
  const p = raw as Record<string, unknown>;
  const extra = Object.keys(p).filter((k) => !['op', 'from', 'to', 'refs'].includes(k));
  if (extra.length > 0) invalid(`unknown param ${extra.map((k) => `"${k}"`).join(', ')}`);
  if (p.op !== 'prices') invalid(`op must be "prices", got ${JSON.stringify(p.op ?? null)}`);
  const from = dayOf(p.from, 'from');
  if (p.to !== undefined && from > dayOf(p.to, 'to')) invalid(`from ${p.from as string} is after to ${p.to as string}`);
  const out: BackfillPricesParams = { op: 'prices', from: p.from as string, ...(p.to !== undefined ? { to: p.to as string } : {}) };
  if (p.refs === undefined) return out;
  const refs = p.refs;
  if (!Array.isArray(refs) || refs.length === 0 || !refs.every((r) => typeof r === 'string' && r !== '')) invalid('refs must be a non-empty list of prices.yaml refs');
  const list = refs as string[];
  const twice = list.find((r, i) => list.indexOf(r) !== i);
  if (twice !== undefined) invalid(`ref "${twice}" is listed twice`);
  const unknown = list.find((r) => !prices.has(r));
  if (unknown !== undefined) invalid(`ref ${unknown} is not in prices.yaml`);
  return { ...out, refs: [...list] };
}

/**
 * A prices backfill request as queued (`orion job run-now backfill-prices`, R27): parsePricesBackfillParams, then `to`
 * frozen at `now` (absent: today, UTC) and stored, from <= to <= today, at most PRICES_BACKFILL_MAX_DAYS days counting
 * both. The span is checked here only. Throws `invalid_backfill_params`.
 */
export function pricesBackfillRequest(raw: unknown, prices: ReadonlyMap<string, PriceEntry>, now: Date): BackfillPricesParams {
  const parsed = parsePricesBackfillParams(raw, prices);
  const today = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
  const todayDay = new Date(today).toISOString().slice(0, 10);
  const from = Date.parse(`${parsed.from}T00:00:00Z`);
  if (parsed.to !== undefined && Date.parse(`${parsed.to}T00:00:00Z`) > today) invalid(`to ${parsed.to} is after today (${todayDay})`);
  const to = parsed.to ?? todayDay;
  if (from > today) invalid(`from ${parsed.from} is after today (${todayDay})`);
  const days = (Date.parse(`${to}T00:00:00Z`) - from) / DAY_MS + 1;
  if (days > PRICES_BACKFILL_MAX_DAYS) invalid(`${parsed.from}..${to} is ${days} days; a prices backfill covers at most ${PRICES_BACKFILL_MAX_DAYS}`);
  return { op: 'prices', from: parsed.from, to, ...(parsed.refs ? { refs: parsed.refs } : {}) };
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

// ---- op: prices (Phase 3 R2 Task 7) ---------------------------------------------------------------------------------

/** A job's params naming op `prices` (validated by parsePricesBackfillParams before use). */
function isPricesRequest(raw: unknown): boolean {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw) && (raw as { op?: unknown }).op === 'prices';
}

/**
 * A prices backfill's progress over its runs, kept on the job row (saveJobProgress) while it defers: the runs that used
 * their budget, their work time, RPC requests per chain, rows written per ref and breaches. A run whose lease was lost
 * adds nothing (its counts went with it; the rows it committed are counted by the done line's `prices` query).
 */
export interface PricesBackfillProgress {
  op: 'prices';
  runs: number;
  workMs: number;
  calls: Record<string, number>;
  written: Record<string, number>;
  breaches: number;
}

/** What a done prices backfill stores and posts. `rows`: the stored rows per ref, under its primary's source, in range. */
export interface PricesBackfillResult extends PricesBackfillProgress {
  from: string;
  to: string | null;
  refs: string[];
  rows: Record<string, number>;
  /** The oldest hour of the oldest day every chain of the last run finished (WriteResult.reachedMs); null: none. */
  reachedIso: string | null;
  /** The last run's hours without a row, by reason (it re-reads every hour still missing in the range). */
  missing: Record<string, number>;
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const counts = (v: unknown): Record<string, number> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).filter((e): e is [string, number] => isCount(e[1]))) : {};

/** The progress stored on the job (none yet: zeros). */
function progressOf(result: unknown): PricesBackfillProgress {
  const r = result !== null && typeof result === 'object' && !Array.isArray(result) ? (result as Record<string, unknown>) : {};
  if (r.op !== 'prices') return { op: 'prices', runs: 0, workMs: 0, calls: {}, written: {}, breaches: 0 };
  return {
    op: 'prices', runs: isCount(r.runs) ? r.runs : 0, workMs: isCount(r.workMs) ? r.workMs : 0, calls: counts(r.calls), written: counts(r.written),
    breaches: isCount(r.breaches) ? r.breaches : 0,
  };
}

const addCounts = (a: Record<string, number>, b: Record<string, number>): Record<string, number> => {
  const out = { ...a };
  for (const [k, n] of Object.entries(b)) out[k] = (out[k] ?? 0) + n;
  return out;
};
const byKey = (o: Record<string, number>): [string, number][] => Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/** A job row's result holding a prices backfill's progress (saved by an earlier run). */
function isPricesProgress(result: unknown): boolean {
  return result !== null && typeof result === 'object' && !Array.isArray(result) && (result as { op?: unknown }).op === 'prices';
}

/** A chain the writer stopped, as `price_chain_stopped: <chain> stopped at <iso>: <error, first line>`. */
function chainStopped(e: WriteResult['errors'][number]): { code: string; message: string } {
  return { code: 'price_chain_stopped', message: `${e.chain} stopped at ${new Date(e.hourMs).toISOString()}: ${e.error.split('\n')[0]}` };
}

/** The real price transports, as a fetch's writer builds them (src/ingest/run.ts priceWriterOf), on the job's env. */
function realPriceDeps(ctx: JobContext, prices: ReadonlyMap<string, PriceEntry>): PriceDeps {
  const f = realFetchDeps(ctx.envVars, () => ctx.clock.now());
  return makePriceDeps(f.env, { rpcFactory: f.rpcFactory, prices, http: f.http, now: ctx.clock.now() });
}

/** Stored rows per ref in [fromHourMs, toHourMs), under each ref's primary source (the rows the writer skips). */
async function storedRows(ctx: JobContext, prices: ReadonlyMap<string, PriceEntry>, refs: string[], fromHourMs: number, toHourMs: number): Promise<Record<string, number>> {
  const got = await ctx.db.all<{ token_ref: string; source: string; n: number }>(
    'SELECT token_ref, source, count(*)::int AS n FROM prices WHERE token_ref = ANY($1::text[]) AND ts >= $2 AND ts < $3 GROUP BY 1, 2',
    [refs, new Date(fromHourMs).toISOString(), new Date(toHourMs).toISOString()],
  );
  const rows: Record<string, number> = {};
  for (const ref of refs) {
    const source = methodSource(prices.get(ref)!.primary);
    rows[ref] = got.find((r) => r.token_ref === ref && r.source === source)?.n ?? 0;
  }
  return rows;
}

/**
 * A `backfill` of op `prices` (Phase 3 R2 Task 7, Review Focus 4): the chain prices of `refs` (default: every prices.yaml
 * ref; each from its own valid_from, the writer's rule) over [from 00:00Z, min(to + 1 day, the last completed hour)),
 * through writeChainPrices under the `job:prices` run lock (PRICES_LOCK), PRICES_BACKFILL_BUDGET_MS (10 min, R28) a run. The writer commits a chain-day
 * at a time and skips every hour already stored, so the job resumes from `prices` itself: stopped by its budget it
 * defers to now (re-queued at its priority, 70, so the hourly levels job runs between budgets; its progress stays on the
 * row), and a run whose lease was lost (the job is re-queued while attempts remain, PRICES_BACKFILL_MAX_ATTEMPTS) posts
 * nothing and the next run never re-reads a committed chain-day. backfillWaitUntil applies to every run, as to op fetch.
 * Each run posts its check breaches (breachLines); done posts one line: stored rows per ref, the oldest hour reached,
 * the hours still missing by reason, RPC requests per chain, breaches and the work time over its runs. A chain the
 * writer stopped (a transport failure) fails the job with one ALERT line; queued again, it resumes.
 */
async function runPricesBackfill(job: Job, ctx: JobContext, o: BackfillHandlerOptions): Promise<JobOutcome> {
  let startedMs: number | null = null;
  let failure: { code: string; message: string };
  // A failure keeps the progress the earlier runs saved on the row (finishJob writes `result`).
  let result: PricesBackfillResult | PricesBackfillProgress | null = isPricesProgress(job.result) ? progressOf(job.result) : null;
  try {
    const prices = loadPrices(ctx.paths.configRoot);
    // Ruling R32(c): a missing, empty or comment-only prices.yaml fails the job with its ALERT, never a "done" with nothing written.
    if (prices.size === 0) throw new OrionError('invalid_price_config', 'prices.yaml has no entries');
    const now = ctx.clock.now();
    const params = parsePricesBackfillParams(job.params, prices);
    const until = await backfillWaitUntil(ctx, now);
    if (until !== null) return { status: 'deferred', untilMs: until };
    const refs = params.refs ?? [...prices.keys()].sort();
    const fromHourMs = Date.parse(`${params.from}T00:00:00Z`);
    const lastHour = Math.floor(now.getTime() / MS_PER_HOUR) * MS_PER_HOUR;
    const toHourMs = Math.max(fromHourMs, params.to === undefined ? lastHour : Math.min(Date.parse(`${params.to}T00:00:00Z`) + DAY_MS, lastHour));
    const deps = o.priceDeps ? o.priceDeps(ctx, prices) : realPriceDeps(ctx, prices);
    const writer = o.writer ?? writeChainPrices;
    const before = progressOf(job.result);
    ctx.log(`backfill prices ${params.from}..${params.to ?? 'now'} ${params.refs ? refs.join(', ') : 'every ref'}`);
    const w = await withRunLock(ctx.db, PRICES_LOCK, lockHolder('daemon backfill prices'), now, async () => {
      startedMs = ctx.clock.now().getTime();
      return await writer(ctx.db, deps, refs, fromHourMs, toHourMs, {
        signal: ctx.signal, budgetMs: o.pricesBudgetMs ?? PRICES_BACKFILL_BUDGET_MS, clock: () => ctx.clock.now().getTime(),
      });
    });
    if (ctx.signal.aborted || w.stoppedBySignal) return aborted;
    const progress: PricesBackfillProgress = {
      op: 'prices', runs: before.runs + 1, workMs: before.workMs + (ctx.clock.now().getTime() - startedMs!), calls: addCounts(before.calls, w.calls),
      written: addCounts(before.written, w.written), breaches: before.breaches + w.breaches.length,
    };
    result = progress;
    for (const text of breachLines(ctx.env, 'backfill', w.breaches, prices)) {
      if (ctx.signal.aborted) return aborted;
      const sent = await ctx.notify.post(text);
      if (!sent.ok) ctx.log(`breach line not delivered: ${sent.error ?? 'unknown error'}`);
    }
    if (w.stoppedByBudget) {
      if (!(await saveJobProgress(ctx.db, job.id, job.leaseOwner ?? '', progress))) ctx.log('backfill prices: progress not saved (the lease is gone)');
      const n = Object.values(w.written).reduce((a, b) => a + b, 0);
      ctx.log(`backfill prices: budget used after ${n} rows, reached ${w.reachedMs === null ? 'no whole day' : new Date(w.reachedMs).toISOString()}; deferred`);
      if (w.errors.length > 0) {
        // A chain the writer stopped is not dropped because the budget ran out too: one ALERT line now.
        const e = chainStopped(w.errors[0]!);
        const text = `ORION ALERT ${ctx.env} backfill prices: ${e.code}: ${slackClean(e.message)}; the job defers (budget used) and its next run reads the chain again`;
        ctx.log(text);
        if (ctx.signal.aborted) return aborted;
        const posted = await ctx.notify.post(text);
        if (!posted.ok) ctx.log(`alert not delivered: ${posted.error ?? 'unknown error'}`);
      }
      return { status: 'deferred', untilMs: ctx.clock.now().getTime() };
    }
    if (w.errors.length > 0) {
      failure = chainStopped(w.errors[0]!);
    } else {
      const missing: Record<string, number> = {};
      for (const m of w.missing) missing[m.reason] = (missing[m.reason] ?? 0) + 1;
      const done: PricesBackfillResult = {
        ...progress, from: params.from, to: params.to ?? null, refs, rows: await storedRows(ctx, prices, refs, fromHourMs, toHourMs),
        reachedIso: w.reachedMs === null ? null : new Date(w.reachedMs).toISOString(), missing,
      };
      const sym = (ref: string) => prices.get(ref)?.symbol ?? ref;
      const list = (o: Record<string, number>) => (Object.keys(o).length === 0 ? 'none' : byKey(o).map(([k, n]) => `${k} ${n}`).join(', '));
      const text = `ORION BACKFILL ${ctx.env} prices done in ${fmtDuration(done.workMs)} (${params.from}..${params.to ?? 'now'}, ${done.runs} run${done.runs === 1 ? '' : 's'}): `
        + `${refs.map((r) => `${sym(r)} ${done.rows[r]} rows`).join(', ')}; oldest hour ${done.reachedIso ?? 'none'}; missing ${list(missing)}; `
        + `calls ${list(done.calls)}; breaches ${done.breaches}`;
      const posted = await ctx.notify.post(slackClean(text, 2000));
      if (!posted.ok) ctx.log(`backfill line not delivered: ${posted.error ?? 'unknown error'}`);
      return { status: 'done', result: done };
    }
  } catch (err) {
    if (ctx.signal.aborted) return aborted;
    if (err instanceof OrionError && err.code === 'run_in_progress') {
      ctx.log(`${err.message}; deferred`);
      return { status: 'deferred', untilMs: ctx.clock.now().getTime() + REFRESH_LOCKED_RETRY_MS };
    }
    failure = codeOf(err);
  }
  if (ctx.signal.aborted) return aborted;
  const after = startedMs !== null ? ` after ${fmtDuration(ctx.clock.now().getTime() - startedMs)}` : '';
  const text = `ORION ALERT ${ctx.env} backfill prices failed${after}: ${slackClean(failure.code, 60)}: ${slackClean(failure.message)}`;
  const posted = await ctx.notify.post(text);
  if (!posted.ok) ctx.log(`alert not delivered: ${posted.error ?? 'unknown error'}`);
  return { status: 'failed', result, error: `${failure.code}: ${failure.message}` };
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
 * fails the job; a failed cross-check alone leaves it done, named in the line. A job with no asset whose params name op
 * `prices` (`orion job run-now backfill-prices`) is the resumable chain price backfill instead (runPricesBackfill).
 */
export function makeBackfillHandler(o: BackfillHandlerOptions = {}): JobHandler {
  const fetch = o.fetch ?? fetchAsset;
  return async (job, ctx) => {
    if (ctx.signal.aborted) return aborted;
    const assetId = job.assetId;
    if (assetId === null && isPricesRequest(job.params)) return await runPricesBackfill(job, ctx, o);
    if (assetId === null) return { status: 'failed', result: null, error: 'a backfill job needs an asset' };
    const result: BackfillJobResult = { fetchLines: [], written: {} };
    let symbol = assetId.toUpperCase();
    let params: BackfillFetchParams | null = null;
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
      // M1: the price check breaches of the fetch's own price writes (a flow scan writing missing hours inline), as
      // refresh posts them: at most PRICE_WATCH_MAX, then one summary line (breachLines). Posted whatever the outcome.
      for (const text of breachLines(ctx.env, 'backfill', fetched.priceBreaches ?? [], loaded.prices)) {
        if (ctx.signal.aborted) return aborted;
        const sent = await ctx.notify.post(text);
        if (!sent.ok) ctx.log(`breach line not delivered: ${sent.error ?? 'unknown error'}`);
      }
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
