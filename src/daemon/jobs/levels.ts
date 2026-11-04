import { loadAsset, type LoadedAsset } from '../../config/load.js';
import type { Job } from '../../db/jobs.js';
import { listRegistry } from '../../db/registry.js';
import { listWatchStates, putWatchStates } from '../../db/watchState.js';
import { realFetchDeps } from '../../ingest/deps.js';
import type { FetchDeps } from '../../ingest/run.js';
import { runLevels, type LevelsResult } from '../../levels/levels.js';
import { levelWatchRule, watchTransitions } from '../../levels/watchTransitions.js';
import { pingDeadman } from '../../notify/deadman.js';
import { formatWatchCleared, formatWatchPost } from '../../notify/format.js';
import type { WatchRule } from '../../types.js';
import type { JobContext, JobHandler, JobOutcome } from '../daemon.js';

export interface LevelsHandlerOptions {
  /** The transports for this job's fetches. Default: the real ones, on the job's re-read env. */
  fetchDeps?: (ctx: JobContext) => FetchDeps;
  /** For the dead-man ping. Default: the global fetch. */
  fetch?: typeof fetch;
  /** After the read, before the dead-man ping: Task 9 inserts the `levels` snapshot here; a snapshot_push for the job's slot follows. */
  onLevels?: (ctx: JobContext, job: Job, result: LevelsResult) => Promise<void>;
}

export interface LevelsJobResult {
  assets: number;
  rows: number;
  /** Per source; `*` when the asset's read did not run at all (its YAML did not load, or its fetch threw). */
  failed: { assetId: string; sourceId: string; error: string }[];
  fired: string[];
  cleared: string[];
  /** Posts Slack did not take after its retries: kept here, and the dead-man ping is withheld. */
  undelivered: string[];
  deadman: boolean;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const aborted: JobOutcome = { status: 'failed', result: null, error: 'aborted: the lease was lost' };

/**
 * The hourly `levels` job (spec 5.4): reads the level metrics of every active asset into `latest_levels`, posts a watch
 * alert when a level watch starts or stops firing (state in `watch_state`; flow watches are the nightly's), and pings
 * `ORION_DEADMAN_URL` when every asset's read ran (per-source failures included) and every post was delivered. The job
 * fails only when every asset failed; it is never retried (`max_attempts` 1: the next hour is the retry).
 */
export function makeLevelsHandler(o: LevelsHandlerOptions = {}): JobHandler {
  return async (job, ctx) => {
    if (ctx.signal.aborted) return aborted;
    const now = ctx.clock.now();
    const nowIso = now.toISOString();
    const failed: LevelsJobResult['failed'] = [];
    const loaded: LoadedAsset[] = [];
    const ids = (await listRegistry(ctx.db)).filter((r) => r.state === 'active').map((r) => r.assetId).sort();
    for (const id of ids) {
      try {
        loaded.push(loadAsset(ctx.paths.configRoot, id));
      } catch (err) {
        failed.push({ assetId: id, sourceId: '*', error: message(err).split('\n')[0] });
      }
    }
    const deps = o.fetchDeps ? o.fetchDeps(ctx) : realFetchDeps(ctx.envVars, () => ctx.clock.now());
    const out = await runLevels(ctx.db, loaded, deps, now, job.id, { signal: ctx.signal });
    if (ctx.signal.aborted) return aborted;
    for (const p of out.perAsset) failed.push(...p.failed.map((f) => ({ assetId: p.assetId, ...f })));
    failed.sort((a, b) => (a.assetId === b.assetId ? (a.sourceId < b.sourceId ? -1 : 1) : a.assetId < b.assetId ? -1 : 1));
    const threw = new Set(failed.filter((f) => f.sourceId === '*').map((f) => f.assetId));

    // Fire and clear, per asset, from the rows this hour read.
    const posts: string[] = [];
    const fired: string[] = [];
    const cleared: string[] = [];
    for (const p of out.perAsset) {
      if (threw.has(p.assetId)) continue;
      const asset = loaded.find((a) => a.config.id === p.assetId)!.config;
      const evaluated = out.rows
        .filter((r) => r.assetId === p.assetId)
        .flatMap((r) => {
          const rule: WatchRule | null = levelWatchRule(asset.metrics[r.metricKey]);
          return rule === null ? [] : [{ metricKey: r.metricKey, rule, value: r.value }];
        });
      if (evaluated.length === 0) continue;
      const t = watchTransitions(await listWatchStates(ctx.db, p.assetId), p.firings, evaluated, nowIso, p.assetId);
      if (ctx.signal.aborted) return aborted;
      await putWatchStates(ctx.db, t.next);
      const firedNow = t.fired.map((f) => formatWatchPost(asset.symbol, f));
      const clearedNow = t.cleared.map((c) => formatWatchCleared(asset.symbol, c.metricKey, c.rule));
      fired.push(...firedNow);
      cleared.push(...clearedNow);
      posts.push(...firedNow, ...clearedNow);
    }
    const undelivered: string[] = [];
    for (const text of posts) {
      if (ctx.signal.aborted) return aborted;
      if (!(await ctx.notify.post(text)).ok) undelivered.push(text);
    }

    const total = ids.length;
    const allFailed = total > 0 && threw.size === total;
    if (o.onLevels && !allFailed) {
      if (ctx.signal.aborted) return aborted;
      await o.onLevels(ctx, job, out);
      await ctx.enqueue({ kind: 'snapshot_push', assetId: null, slot: job.slot });
    }
    if (ctx.signal.aborted) return aborted;
    const deadman = threw.size === 0 && undelivered.length === 0
      ? await pingDeadman(ctx.envVars.ORION_DEADMAN_URL, o.fetch ?? fetch, (ms) => ctx.clock.sleep(ms))
      : false;
    const result: LevelsJobResult = { assets: total, rows: out.rows.length, failed, fired, cleared, undelivered, deadman };
    if (allFailed) return { status: 'failed', result, error: `every asset failed (${total})` };
    return { status: 'done', result };
  };
}

export const levelsHandler: JobHandler = makeLevelsHandler();
