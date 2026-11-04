import { loadAsset, type LoadedAsset } from '../../config/load.js';
import type { Db } from '../../db/connection.js';
import { listJobs, type Job, type JobStatus } from '../../db/jobs.js';
import { listRegistry, listStateEvents, type RegistryRow } from '../../db/registry.js';
import { listWatchStates } from '../../db/watchState.js';
import { pingDeadman } from '../../notify/deadman.js';
import { formatNightly, nightlyAlerts, slackClean, type NightlyInput } from '../../notify/format.js';
import { fullBody, reportLags } from '../../push/body.js';
import { PUBLISH_OFF } from '../../push/publisher.js';
import { pendingSnapshots } from '../../db/snapshotsOut.js';
import { apiBackfillDays } from '../../registry/actions.js';
import { MS_PER_DAY } from '../../types.js';
import type { JobContext, JobHandler, JobOutcome } from '../daemon.js';
import { reportDay } from '../schedule.js';
import type { RefreshJobResult } from './refresh.js';
import { recordSnapshot } from './snapshotPush.js';

/** The report waits for the slot's refreshes this long after the slot, then posts with what it has. */
export const NIGHTLY_WAIT_MS = 3 * 3_600_000;
/** While a refresh of the slot is unfinished, the report looks again this much later. */
export const NIGHTLY_DEFER_MS = 300_000;
/** A resume within this long before the slot is reported (once: the next slot's window starts after it). */
const RESUME_WINDOW_MS = MS_PER_DAY;

export interface NightlyReportOptions {
  /** For the dead-man ping. Default: the global fetch. */
  fetch?: typeof fetch;
}

/** What the job keeps in `result_json`. `posts` only when a post was not delivered (the text survives Slack being down). */
export interface NightlyJobResult {
  day: string;
  delivered: boolean;
  deadman: boolean;
  alerts: number;
  postCount: number;
  refreshesMissing: string[];
  /** The registry's config hash per asset at this report: the next delivered one's CONFIG CHANGED baseline. */
  configHashes: Record<string, string>;
  posts?: string[];
  undelivered?: number;
  snapshotError?: string;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split('\n')[0]!;
const aborted: JobOutcome = { status: 'failed', result: null, error: 'aborted: the lease was lost' };
const terminal = (s: JobStatus): boolean => s === 'done' || s === 'failed' || s === 'skipped';
const ran = (s: JobStatus): boolean => s === 'done' || s === 'failed';

function tryLoad(configRoot: string, id: string): LoadedAsset | null {
  try {
    return loadAsset(configRoot, id);
  } catch {
    return null;
  }
}

/** The previous delivered nightly's config hashes; null when there is none. */
async function previousHashes(db: Db, job: Job): Promise<Record<string, string> | null> {
  const slotMs = Date.parse(job.slot);
  for (const j of await listJobs(db, { kind: 'nightly_report', limit: 200 })) {
    if (j.id === job.id || Date.parse(j.slot) >= slotMs || j.status !== 'done') continue;
    const r = j.result as Partial<NightlyJobResult> | null;
    if (r?.delivered === true && r.configHashes) return r.configHashes;
  }
  return null;
}

/** Assets resumed in the day before the slot after a pause longer than their API series refill. */
async function resumedShort(db: Db, registry: RegistryRow[], loaded: Map<string, LoadedAsset | null>, slotMs: number): Promise<NightlyInput['resumedShort']> {
  const out: NightlyInput['resumedShort'] = [];
  for (const r of registry) {
    const config = loaded.get(r.assetId)?.config;
    const backfillDays = config ? apiBackfillDays(config) : null;
    if (backfillDays === null) continue;
    const events = await listStateEvents(db, r.assetId, 20); // newest first
    events.forEach((e, i) => {
      const at = Date.parse(e.at);
      if (e.fromState !== 'paused' || at > slotMs || at <= slotMs - RESUME_WINDOW_MS) return;
      const pause = events.slice(i + 1).find((p) => p.toState === 'paused');
      if (!pause) return;
      const pausedDays = Math.floor((at - Date.parse(pause.at)) / MS_PER_DAY);
      if (pausedDays > backfillDays) out.push({ assetId: r.assetId, pausedDays, backfillDays });
    });
  }
  return out;
}

/** Unpushed snapshots older than this are listed (PUBLISH PENDING). */
export const PUBLISH_PENDING_AFTER_MS = 3_600_000;

async function publishState(ctx: JobContext): Promise<NonNullable<NightlyInput['publish']>> {
  const target = (ctx.envVars.ORION_PUBLISH ?? '').trim();
  if (target === '' || target === PUBLISH_OFF) return { off: true, pending: 0, oldest: null };
  const cut = ctx.clock.now().getTime() - PUBLISH_PENDING_AFTER_MS;
  const old = (await pendingSnapshots(ctx.db)).filter((r) => Date.parse(r.createdAt) <= cut);
  return { off: false, pending: old.length, oldest: old[0]?.createdAt ?? null };
}

async function buildInput(ctx: JobContext, job: Job, refreshes: Job[], day: string): Promise<{ input: NightlyInput; configHashes: Record<string, string> }> {
  const slotMs = Date.parse(job.slot);
  const registry = await listRegistry(ctx.db);
  const ids = [...new Set([...registry.map((r) => r.assetId), ...refreshes.flatMap((j) => (j.assetId ? [j.assetId] : []))])];
  const loaded = new Map(ids.map((id) => [id, tryLoad(ctx.paths.configRoot, id)]));
  const symbols = Object.fromEntries(ids.map((id) => [id, loaded.get(id)?.config.symbol ?? id.toUpperCase()]));

  const results: NightlyInput['results'] = refreshes
    .filter((j) => j.assetId !== null && ran(j.status))
    .map((j) => {
      const r = j.result as Partial<RefreshJobResult> | null;
      return {
        assetId: j.assetId!, symbol: symbols[j.assetId!]!, report: r?.report ?? null,
        job: { status: j.status, attempts: j.attempts, error: j.lastError }, fetchLines: r?.fetchLines ?? [], alertFlags: r?.alertFlags ?? [],
      };
    });
  const reported = new Set(results.map((r) => r.assetId));
  // Active since the slot (the assets the scheduler queued a refresh for) with no refresh that ran.
  const refreshesMissing = registry
    .filter((r) => r.state === 'active' && Date.parse(r.stateSince) <= slotMs && !reported.has(r.assetId))
    .map((r) => r.assetId);

  const configHashes = Object.fromEntries(registry.map((r) => [r.assetId, r.configHash]));
  const prev = await previousHashes(ctx.db, job);
  const configChanged = prev === null ? [] : registry.filter((r) => prev[r.assetId] !== undefined && prev[r.assetId] !== r.configHash).map((r) => r.assetId);

  const input: NightlyInput = {
    env: ctx.env, day, releaseTag: ctx.paths.release?.tag ?? null, slot: job.slot, results, symbols,
    notRun: registry.filter((r) => r.state === 'paused' || r.state === 'inactive' || r.state === 'missing'),
    configChanged,
    resumedShort: await resumedShort(ctx.db, registry, loaded, slotMs),
    firingWatches: (await listWatchStates(ctx.db)).filter((w) => w.firing),
    refreshesMissing,
    publish: await publishState(ctx),
    lags: await reportLags(ctx.db, ctx.paths.configRoot, registry, day),
  };
  return { input, configHashes };
}

/**
 * The `nightly_report` job (spec 6, option A): waits until every `refresh` of its slot has finished, or 3 h after the
 * slot (deferring 5 min at a time), then posts the report for the UTC day before the slot (split per asset under 3,900
 * characters), pings `ORION_DEADMAN_NIGHTLY_URL` only when every post was delivered, stores the day's `full` snapshot
 * and queues its `snapshot_push`. Silence means broken: a report that cannot be built posts an ALERT saying so (and
 * fails, without a ping); an undelivered report keeps its text in the result and withholds the ping.
 */
export function makeNightlyReportHandler(o: NightlyReportOptions = {}): JobHandler {
  return async (job, ctx) => {
    if (ctx.signal.aborted) return aborted;
    const slotMs = Date.parse(job.slot);
    const day = reportDay(new Date(slotMs));
    let built: { input: NightlyInput; configHashes: Record<string, string> };
    try {
      const refreshes = await listJobs(ctx.db, { kind: 'refresh', slot: job.slot, limit: 100_000 });
      const cut = slotMs + NIGHTLY_WAIT_MS;
      const now = ctx.clock.now().getTime();
      const waiting = refreshes.filter((j) => !terminal(j.status));
      if (waiting.length > 0 && now < cut) {
        ctx.log(`waiting for ${waiting.length} refresh(es): ${waiting.map((j) => j.assetId).join(', ')}`);
        return { status: 'deferred', untilMs: Math.min(now + NIGHTLY_DEFER_MS, cut) };
      }
      built = await buildInput(ctx, job, refreshes, day);
    } catch (err) {
      if (ctx.signal.aborted) return aborted;
      const text = `ORION ALERT ${ctx.env} nightly ${day}: report not built: ${slackClean(message(err))}`;
      const posted = await ctx.notify.post(text);
      return { status: 'failed', result: { day, delivered: posted.ok, posts: [text] }, error: `nightly report not built: ${message(err)}` };
    }

    const { input, configHashes } = built;
    const posts = formatNightly(input);
    let undelivered = 0;
    for (const text of posts) {
      if (ctx.signal.aborted) return aborted;
      const r = await ctx.notify.post(text);
      if (!r.ok) {
        undelivered++;
        ctx.log(`report post not delivered: ${r.error ?? 'unknown error'}`);
      }
    }
    const delivered = undelivered === 0;
    if (ctx.signal.aborted) return aborted;
    const deadman = delivered ? await pingDeadman(ctx.envVars.ORION_DEADMAN_NIGHTLY_URL, o.fetch ?? fetch, (ms) => ctx.clock.sleep(ms)) : false;

    const result: NightlyJobResult = {
      day, delivered, deadman, alerts: nightlyAlerts(input),
      postCount: posts.length, refreshesMissing: input.refreshesMissing, configHashes,
      ...(delivered ? {} : { posts, undelivered }),
    };
    if (ctx.signal.aborted) return aborted;
    try {
      await recordSnapshot(ctx, 'full', await fullBody(ctx.db, ctx.paths.configRoot, await listRegistry(ctx.db), day), day);
      await ctx.enqueue({ kind: 'snapshot_push', assetId: null, slot: job.slot });
    } catch (err) {
      result.snapshotError = message(err);
      const r = await ctx.notify.post(`ORION ALERT ${ctx.env} nightly ${day}: the full snapshot was not stored: ${slackClean(message(err))}`);
      if (!r.ok) ctx.log(`alert not delivered: ${r.error ?? 'unknown error'}`);
    }
    return { status: 'done', result };
  };
}

/** The daemon's nightly report. */
export const nightlyReportHandler: JobHandler = makeNightlyReportHandler();

/** One nightly as `daemon status --json` shows it (the staging soak gate reads it). */
export interface NightlyStatus {
  tag: string | null;
  nightly_slot: string;
  status: JobStatus;
  /** `<asset>:<sourceId>` of every source the slot's refreshes listed failed; `<asset>:*` for a refresh that failed whole. */
  failed_sources: string[];
}

/**
 * The newest scheduler-made `nightly_report` that is `done`: with `tag` (the soak of that release, I-3) it must also
 * have run on `tag`, and its slot must have at least one refresh, every one finished (done, failed or skipped) and run
 * on `tag` too, so a nightly deferred across a switch that only reports the previous release's refreshes is no soak.
 * Without `tag`: any release (`last_nightly`). Run-now reports do not count. Null when there is none.
 */
export async function nightlyStatus(db: Db, tag?: string): Promise<NightlyStatus | null> {
  const candidates = (await listJobs(db, { kind: 'nightly_report', limit: 1000 }))
    .filter((j) => j.status === 'done' && j.requestedBy === 'scheduler' && (tag === undefined || j.releaseTag === tag));
  for (const job of candidates) {
    const refreshes = (await listJobs(db, { kind: 'refresh', slot: job.slot, limit: 100_000 })).filter((j) => j.assetId !== null);
    if (tag !== undefined && (refreshes.length === 0 || refreshes.some((j) => !terminal(j.status) || j.releaseTag !== tag))) continue;
    const failed = new Set<string>();
    for (const j of refreshes) {
      const r = j.result as Partial<RefreshJobResult> | null;
      const sources = r?.report?.ingest?.sources_failed;
      if (sources) for (const s of sources) failed.add(`${j.assetId}:${s}`);
      else if (j.status === 'failed') failed.add(`${j.assetId}:*`);
    }
    return { tag: job.releaseTag, nightly_slot: job.slot, status: job.status, failed_sources: [...failed].sort() };
  }
  return null;
}
