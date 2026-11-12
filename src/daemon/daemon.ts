import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { loadEnv } from '../cli/env.js';
import type { OrionEnv, OrionPaths } from '../cli/paths.js';
import type { Db, OrionDb } from '../db/connection.js';
import { beat as writeBeat, getHeartbeat, startHeartbeat, stopStaleHeartbeats, type HeartbeatState } from '../db/heartbeat.js';
import {
  abandonRunning, claimNextJob, deferJob, enqueueJob, finishJob, reapExpired, renewLease, retryJob, type Job, type JobKind, type NewJob,
} from '../db/jobs.js';
import type { AssetRunLock } from '../db/pg/pool.js';
import { migrationStatus } from '../db/pg/migrate.js';
import { listRegistry } from '../db/registry.js';
import type { Notifier } from '../notify/slack.js';
import { loadAssetYamls, reconcileFromDisk } from '../registry/reconcile.js';
import { checkPublishTarget, PUBLISH_OFF } from '../push/publisher.js';
import { OrionError } from '../types.js';
import { backfillHandler } from './jobs/backfill.js';
import { disclosureWatchHandler } from './jobs/disclosureWatch.js';
import { levelsHandler } from './jobs/levels.js';
import { nightlyReportHandler } from './jobs/nightlyReport.js';
import { refreshHandler } from './jobs/refresh.js';
import { retentionHandler } from './jobs/retention.js';
import { snapshotPushHandler } from './jobs/snapshotPush.js';
import { stagingRefreshHandler } from './jobs/stagingRefresh.js';
import { loadSchedule, newestSlot, type ScheduleEntry } from './schedule.js';
import type { SystemdNotifier } from './systemd.js';

/**
 * The `orion daemon` process (spec 5.1-5.2): one per environment. A scheduler enqueues the newest slot of every
 * schedule entry every 30 s (idempotent: a job exists once per kind, asset and slot, so two schedulers or a restart
 * never double a job, and after downtime only the newest missed slot is created). One worker claims jobs under a
 * 3 min lease renewed every 60 s. A session advisory lock makes the daemon a singleton per database (plan R8), which is
 * what lets start-up treat every `running` job as abandoned by a dead daemon.
 */

export interface Clock {
  now(): Date;
  sleep(ms: number): Promise<void>;
}

/** Wall time. Its sleeps do not keep the process alive on their own (the `orion daemon` command holds it open). */
export const realClock: Clock = {
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  }),
};

/**
 * What a handler returns. `failed` is retried at `now + retryAfterMs` while attempts remain and `retryAfterMs` is
 * given; `deferred` puts the job back until the epoch time `untilMs` without using up an attempt (it could not start).
 */
export type JobOutcome =
  | { status: 'done' | 'skipped'; result: unknown }
  | { status: 'failed'; result: unknown; error: string; retryAfterMs?: number }
  | { status: 'deferred'; untilMs: number };

export interface JobContext {
  /** A root handle (pool): `tickAsset` takes the asset's run lock on its own connection. */
  db: OrionDb;
  clock: Clock;
  env: OrionEnv;
  paths: OrionPaths;
  /** `loadEnv(paths.envFile, process.env)`, re-read for each job (secrets can change between jobs). */
  envVars: Record<string, string | undefined>;
  /** Slack, fenced: once `signal` is aborted a post is not sent (it returns `ok: false`). */
  notify: Notifier;
  /**
   * Aborted when a lease renewal finds the job gone (re-queued elsewhere, I-1): the handler must stop before any
   * further side effect (check it before a Slack post, a ping or a write); whatever it returns is dropped.
   */
  signal: AbortSignal;
  enqueue(j: NewJob): Promise<Job | null>;
  log(line: string): void;
  /**
   * The CoinGecko market_chart replies shared by every job of one slot (N8: the nightly's refreshes fetch each chart
   * once). Unset: no sharing.
   */
  sharedHttpCache?: (slot: string) => Map<string, Promise<unknown>>;
}

export type JobHandler = (job: Job, ctx: JobContext) => Promise<JobOutcome>;

export interface DaemonDeps {
  /** A root handle: the singleton lock is a session lock on its own connection. */
  db: OrionDb;
  clock: Clock;
  env: OrionEnv;
  paths: OrionPaths;
  handlers: Partial<Record<JobKind, JobHandler>>;
  notifier: (envVars: Record<string, string | undefined>) => Notifier;
  systemd: SystemdNotifier;
  log(line: string): void;
  daemonId: string;
  /** The assets a nightly slot refreshes: active, and active since the slot or earlier. */
  activeAssets(db: Db, slot: Date): Promise<string[]>;
  /** `orion daemon --allow-retire`: accept a reconcile that retires every asset or more than 2 at once (I-3). */
  allowRetire?: boolean;
}

export const SCHEDULER_INTERVAL_MS = 30_000;
export const WATCHDOG_INTERVAL_MS = 30_000;
export const IDLE_POLL_MS = 5_000;
export const LEASE_RENEW_MS = 60_000;
/** The heartbeat row is written at each job start and end, and at least this often (never on the 30 s watchdog beat). */
export const HEARTBEAT_INTERVAL_MS = 15 * 60_000;
/** When a handler throws: a retry after 10 min, if the kind has attempts left (only `refresh` does). */
export const RESTART_RETRY_MS = 600_000;
export const JOB_ERROR_MAX = 300;
/** The singleton's lock id, in the run-lock key space (schema-scoped; no asset id contains a colon). */
export const DAEMON_LOCK_ID = 'orion:daemon';
/** Slots whose shared HTTP cache is kept: the nightly's, plus one more (a run-now job meanwhile does not evict it). */
export const SHARED_CACHE_SLOTS = 2;

/**
 * The active assets the nightly slot `slot` refreshes: active since `slot` or earlier. An asset activated (or resumed)
 * after the slot began gets no refresh for it; its first is the next night's, or `orion job run-now refresh <a>`.
 */
export async function activeAssetIds(db: Db, slot: Date): Promise<string[]> {
  const at = slot.getTime();
  return (await listRegistry(db)).filter((r) => r.state === 'active' && Date.parse(r.stateSince) <= at).map((r) => r.assetId);
}

/** The handlers `orion daemon` runs with. */
export function defaultHandlers(): Partial<Record<JobKind, JobHandler>> {
  return {
    refresh: refreshHandler,
    nightly_report: nightlyReportHandler,
    levels: levelsHandler,
    snapshot_push: snapshotPushHandler,
    disclosure_watch: disclosureWatchHandler,
    staging_refresh: stagingRefreshHandler,
    retention: retentionHandler,
    backfill: backfillHandler,
  };
}

/** Staging never publishes to the prod snapshot repo, nor prod to staging's (N11); lives with the publisher. */
export { checkPublishTarget };

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** M-1: the last start-up failure posted, in the data home. */
export const START_FAILURE_FILE = 'start-failure.json';

function forgetStartFailure(home: string): void {
  try {
    unlinkSync(join(home, START_FAILURE_FILE));
  } catch {
    // nothing remembered
  }
}

/**
 * I-1, I-2: stage and prod deliver or they do not run. A blank `SLACK_WEBHOOK_URL` would post nothing while the
 * dead-man stays green, a blank `ORION_DEADMAN_NIGHTLY_URL` would leave a dead daemon unnoticed, and an unset
 * `ORION_PUBLISH` would stop publishing without a word (`off` says so on purpose, and every nightly prints it).
 */
export function requireDeliveryVars(env: OrionEnv, vars: Record<string, string | undefined>): void {
  if (env === 'dev') return;
  const blank = (k: string): boolean => (vars[k] ?? '').trim() === '';
  if (blank('SLACK_WEBHOOK_URL')) throw new OrionError('slack_webhook_missing', `ORION_ENV=${env} needs SLACK_WEBHOOK_URL in the .env (nothing would be posted)`);
  if (blank('ORION_DEADMAN_NIGHTLY_URL')) throw new OrionError('deadman_url_missing', `ORION_ENV=${env} needs ORION_DEADMAN_NIGHTLY_URL in the .env`);
  if (blank('ORION_PUBLISH')) {
    throw new OrionError('publish_unset', `ORION_ENV=${env} needs ORION_PUBLISH in the .env: git:<url>#<branch>, or ${PUBLISH_OFF} to run without publishing`);
  }
}
const label = (j: Job): string => `job ${j.id} ${j.kind}${j.assetId ? ` ${j.assetId}` : ''}`;

export class Daemon {
  private schedule: ScheduleEntry[] | null = null;
  private lock: AssetRunLock | null = null;
  private state: HeartbeatState = 'running';
  private currentJobId: number | null = null;
  private lastBeatMs = 0;
  private stopRequested = false;
  /** Set when the singleton lock's connection is found dead: `run` stops and throws it (the process exits non-zero). */
  private fatal: OrionError | null = null;
  private wakeStop!: () => void;
  private readonly stopSignal: Promise<void>;
  /** Per slot, oldest first: the market_chart replies the slot's jobs share. */
  private readonly slotCaches = new Map<string, Map<string, Promise<unknown>>>();

  constructor(private readonly d: DaemonDeps) {
    this.stopSignal = new Promise((resolve) => {
      this.wakeStop = resolve;
    });
  }

  /** The slot's shared HTTP cache; only the SHARED_CACHE_SLOTS newest slots asked for are kept. */
  private sharedHttpCache(slot: string): Map<string, Promise<unknown>> {
    let cache = this.slotCaches.get(slot);
    if (!cache) {
      cache = new Map();
      this.slotCaches.set(slot, cache);
      while (this.slotCaches.size > SHARED_CACHE_SLOTS) this.slotCaches.delete(this.slotCaches.keys().next().value!);
    }
    return cache;
  }

  private envVars(): Record<string, string | undefined> {
    return loadEnv(this.d.paths.envFile, process.env);
  }

  private get releaseTag(): string | null {
    return this.d.paths.release?.tag ?? null;
  }

  /**
   * Takes the singleton lock, runs the start-up checks (schema, every asset YAML, schedule.yaml, the publish target),
   * reconciles the registry with the release, writes this daemon's heartbeat row, returns the dead daemon's running
   * jobs to the queue, tells systemd it is ready, then posts one RESTARTED line per such job. Any check failing throws
   * before READY and before the heartbeat row, and lets go of the lock.
   */
  async start(): Promise<void> {
    const { db, clock, paths, env, daemonId } = this.d;
    const lock = await db.tryAssetRunLock(DAEMON_LOCK_ID, `orion daemon ${daemonId}`);
    if (!lock) throw new OrionError('daemon_running', 'another orion daemon holds this database');
    this.lock = lock;
    let beating = false;
    try {
      const status = await migrationStatus(db);
      if (status.pending.length > 0) {
        throw new OrionError('schema_behind', `database schema ${db.schema} is at ${status.dbAt}, this build needs ${status.codeRequires}: run orion db migrate`);
      }
      const envVars = this.envVars();
      requireDeliveryVars(env, envVars);
      loadAssetYamls(paths.configRoot);
      this.schedule = loadSchedule(paths.configRoot, env);
      checkPublishTarget(env, envVars.ORION_PUBLISH);
      const now = clock.now();
      await reconcileFromDisk(db, paths.configRoot, this.releaseTag, now, { allowRetire: this.d.allowRetire === true });
      await stopStaleHeartbeats(db, daemonId);
      await startHeartbeat(db, { daemonId, pid: process.pid, host: hostname(), releaseTag: this.releaseTag, startedAt: now.toISOString() });
      beating = true;
      this.lastBeatMs = now.getTime();
      const { requeued, failed } = await abandonRunning(db, now);
      // READY before the posts: a Slack outage retries for up to 5 min, which would eat systemd's start timeout.
      this.d.systemd.ready();
      this.d.log(`daemon started: ${daemonId} env ${env} release ${this.releaseTag ?? '(dev checkout)'} database ${db.database} schema ${db.schema}`);
      const notify = this.d.notifier(envVars);
      for (const j of requeued) await this.alert(notify, `ORION RESTARTED ${env} after unclean exit, job ${j.id} re-queued`);
      for (const j of failed) await this.alert(notify, `ORION RESTARTED ${env} after unclean exit, job ${j.id} failed (lease_expired)`);
      forgetStartFailure(paths.home);
    } catch (err) {
      if (beating) {
        this.state = 'stopped';
        await this.heartbeat({ checkLock: false }).catch(() => undefined);
      }
      this.lock = null;
      await lock.release().catch(() => undefined);
      await this.alertStartFailure(err).catch(() => undefined);
      throw err;
    }
  }

  /**
   * M-1: one ALERT per distinct start-up failure (best effort: an unset webhook only logs), so a unit restarting every
   * 30 s posts once, not 2,900 times a day. The last one posted is kept in `<home>/start-failure.json` until a start
   * succeeds.
   */
  private async alertStartFailure(err: unknown): Promise<void> {
    const code = err instanceof OrionError ? err.code : 'error';
    const text = `ORION ALERT ${this.d.env}: daemon not started: ${message(err).split('\n', 1)[0]}`;
    const file = join(this.d.paths.home, START_FAILURE_FILE);
    let last: { code?: string; text?: string } = {};
    try {
      last = JSON.parse(readFileSync(file, 'utf8')) as typeof last;
    } catch {
      // none yet
    }
    if (last.code === code && last.text === text) {
      this.d.log(`${text} (not posted again: same as the last failed start)`);
      return;
    }
    let notify: Notifier;
    try {
      notify = this.d.notifier(this.envVars());
    } catch (e) {
      this.d.log(`${text} (not posted: ${message(e)})`);
      return;
    }
    await this.alert(notify, text);
    try {
      writeFileSync(file, `${JSON.stringify({ code, text, at: this.d.clock.now().toISOString() })}\n`);
    } catch (e) {
      this.d.log(`cannot remember the start failure in ${file}: ${message(e)}`);
    }
  }

  private async alert(notify: Notifier, text: string): Promise<void> {
    this.d.log(text);
    try {
      const r = await notify.post(text);
      if (!r.ok) this.d.log(`alert not delivered: ${r.error ?? 'unknown error'}`);
    } catch (err) {
      this.d.log(`alert not delivered: ${message(err)}`);
    }
  }

  /** Enqueues the newest slot of each schedule entry (nightly: one refresh per active asset and one report). How many were new. */
  async schedulerTick(): Promise<number> {
    const { db, clock, paths, env } = this.d;
    this.schedule ??= loadSchedule(paths.configRoot, env);
    const now = clock.now();
    let added = 0;
    const add = async (j: NewJob): Promise<void> => {
      const job = await enqueueJob(db, { ...j, releaseTag: this.releaseTag });
      if (job) {
        added++;
        this.d.log(`queued ${label(job)} slot ${job.slot}`);
      }
    };
    for (const e of this.schedule) {
      const slot = newestSlot(e.cadence, now).toISOString();
      if (e.key === 'nightly') {
        for (const id of await this.d.activeAssets(db, new Date(slot))) await add({ kind: 'refresh', assetId: id, slot });
        await add({ kind: 'nightly_report', assetId: null, slot });
      } else {
        await add({ kind: e.key, assetId: null, slot });
      }
    }
    return added;
  }

  private async drainRequested(): Promise<boolean> {
    return (await getHeartbeat(this.d.db, this.d.daemonId))?.drainRequestedAt != null;
  }

  /**
   * Writes the heartbeat row; first (unless `checkLock: false`) pings the singleton lock's connection. A dead one means
   * another daemon could start: this one stops and `run` throws `daemon_lock_lost`, so systemd restarts it and the new
   * process takes the lock again.
   */
  private async heartbeat(opts: { checkLock?: boolean } = {}): Promise<void> {
    if (opts.checkLock !== false) await this.checkLock();
    const now = this.d.clock.now();
    await writeBeat(this.d.db, this.d.daemonId, { currentJobId: this.currentJobId, state: this.state }, now);
    this.lastBeatMs = now.getTime();
  }

  private async checkLock(): Promise<void> {
    const lock = this.lock;
    if (!lock) return;
    try {
      await lock.ping();
    } catch (err) {
      if (!this.fatal) {
        this.fatal = new OrionError('daemon_lock_lost', `the daemon's singleton lock is gone (${message(err)}); exiting so that a restart takes it again`);
        this.d.log(`singleton lock lost: ${message(err)}; stopping`);
        this.requestStop();
      }
      throw this.fatal;
    }
  }

  /**
   * One claim: unless a drain is requested (then reports `drained` and claims nothing), re-queues expired leases,
   * claims the next due job and runs it to its outcome. Whether a job ran.
   */
  async workerTick(): Promise<boolean> {
    const { db, clock } = this.d;
    if (this.stopRequested) return false;
    if (await this.drainRequested()) {
      if (this.state !== 'drained') {
        this.state = 'drained';
        await this.heartbeat();
        this.d.log('drained: claiming nothing until orion daemon undrain');
      }
      return false;
    }
    if (this.state !== 'running') {
      this.state = 'running';
      await this.heartbeat();
      this.d.log('drain withdrawn: claiming jobs again');
    }
    const now = clock.now();
    // Never this daemon's own jobs (I-1): one is in flight only while its renewal runs; a restart takes them back.
    const reaped = await reapExpired(db, now, this.d.daemonId);
    for (const j of reaped.requeued) this.d.log(`${label(j)}: lease expired, re-queued`);
    for (const j of reaped.failed) this.d.log(`${label(j)}: lease expired, failed (no attempts left)`);
    const job = await claimNextJob(db, this.d.daemonId, now, this.releaseTag);
    if (!job) return false;
    await this.runJob(job);
    return true;
  }

  private async runJob(job: Job): Promise<void> {
    const { db, clock, env, paths } = this.d;
    const name = label(job);
    this.currentJobId = job.id;
    await this.heartbeat();
    this.d.log(`${name} started (attempt ${job.attempts} of ${job.maxAttempts})`);
    let outcome: JobOutcome;
    let finished!: () => void;
    const ended = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const abort = new AbortController();
    const renewal = this.renewWhileRunning(job, ended, abort);
    try {
      const envVars = this.envVars();
      const ctx: JobContext = {
        db, clock, env, paths, envVars, notify: this.fenced(this.d.notifier(envVars), abort.signal, name), signal: abort.signal,
        enqueue: async (j) => await enqueueJob(db, { releaseTag: this.releaseTag, ...j }),
        log: (line) => this.d.log(`${name}: ${line}`),
        sharedHttpCache: (slot) => this.sharedHttpCache(slot),
      };
      const handler = this.d.handlers[job.kind];
      outcome = handler ? await handler(job, ctx) : { status: 'failed', result: null, error: `no handler for job kind ${job.kind}` };
    } catch (err) {
      outcome = { status: 'failed', result: null, error: message(err), retryAfterMs: RESTART_RETRY_MS };
    } finally {
      finished();
      await renewal;
    }
    try {
      if (abort.signal.aborted) this.d.log(`${name}: aborted (lease lost), result dropped (${outcome.status})`);
      else await this.record(job, outcome);
    } catch (err) {
      if (err instanceof OrionError && err.code === 'job_lease_lost') {
        // R-c6: another daemon took the job over (the lease ran out): its run owns the row now. Drop this result.
        this.d.log(`${name}: lease lost, result dropped (${outcome.status})`);
      } else {
        // M-3: never leave the row running under this daemon (only a restart would reap it): give the lease back.
        await this.requeueUnrecorded(job, err);
      }
    } finally {
      this.currentJobId = null;
      await this.heartbeat();
    }
  }

  private async requeueUnrecorded(job: Job, err: unknown): Promise<void> {
    const name = label(job);
    const at = new Date(this.d.clock.now().getTime() + RESTART_RETRY_MS);
    try {
      await deferJob(this.d.db, job.id, this.d.daemonId, at);
      this.d.log(`${name}: could not record its result (${message(err)}); re-queued for ${at.toISOString()}`);
    } catch (again) {
      this.d.log(`${name}: could not record its result (${message(err)}) nor re-queue it (${message(again)}); a restart re-queues it`);
    }
  }

  private async record(job: Job, o: JobOutcome): Promise<void> {
    const { db, clock, daemonId } = this.d;
    const now = clock.now();
    const name = label(job);
    if (o.status === 'deferred') {
      await deferJob(db, job.id, daemonId, new Date(o.untilMs));
      this.d.log(`${name} deferred until ${new Date(o.untilMs).toISOString()}`);
    } else if (o.status === 'failed') {
      const error = o.error.slice(0, JOB_ERROR_MAX);
      if (job.attempts < job.maxAttempts && o.retryAfterMs !== undefined) {
        const at = new Date(now.getTime() + o.retryAfterMs);
        await retryJob(db, job.id, daemonId, at, error);
        this.d.log(`${name} failed (attempt ${job.attempts} of ${job.maxAttempts}), retry at ${at.toISOString()}: ${error}`);
      } else {
        await finishJob(db, job.id, daemonId, { status: 'failed', result: o.result, error }, now);
        this.d.log(`${name} failed: ${error}`);
      }
    } else {
      await finishJob(db, job.id, daemonId, { status: o.status, result: o.result }, now);
      this.d.log(`${name} ${o.status}`);
    }
  }

  /** A notifier that sends nothing once `signal` is aborted: an aborted job's late posts never reach Slack. */
  private fenced(notify: Notifier, signal: AbortSignal, name: string): Notifier {
    return {
      post: async (text) => {
        if (signal.aborted) {
          this.d.log(`${name}: post not sent, the job was aborted: ${text.split('\n', 1)[0]}`);
          return { ok: false, attempts: 0, error: 'job aborted: lease lost' };
        }
        return await notify.post(text);
      },
    };
  }

  /**
   * Renews the lease every 60 s on its own timer until the handler ends (a handler awaiting a slow Slack post does not
   * hold it up); notices a drain request meanwhile (state `draining`). A renewal that finds the job gone aborts it.
   */
  private async renewWhileRunning(job: Job, ended: Promise<void>, abort: AbortController): Promise<void> {
    const { db, clock, daemonId } = this.d;
    for (;;) {
      const woke = await Promise.race([clock.sleep(LEASE_RENEW_MS).then(() => 'renew' as const), ended.then(() => 'ended' as const)]);
      if (woke === 'ended') return;
      try {
        if (!(await renewLease(db, job.id, daemonId, clock.now()))) {
          this.d.log(`${label(job)}: lease lost (re-queued elsewhere); aborting it, its result will be dropped`);
          abort.abort(new OrionError('job_lease_lost', `${label(job)}: lease lost`));
          return;
        }
        if (this.state === 'running' && (await this.drainRequested())) {
          this.state = 'draining';
          await this.heartbeat();
          this.d.log(`drain requested: finishing ${label(job)}, then claiming nothing`);
        }
      } catch (err) {
        this.d.log(`${label(job)}: lease renewal failed: ${message(err)}`);
      }
    }
  }

  /** SIGTERM: the current job finishes, nothing new is claimed, then `run` marks the heartbeat stopped and returns. */
  requestStop(): void {
    if (this.stopRequested) return;
    this.stopRequested = true;
    this.d.systemd.stopping();
    this.d.log(this.currentJobId === null ? 'stop requested' : `stop requested: finishing job ${this.currentJobId}`);
    this.wakeStop();
  }

  private async pause(ms: number): Promise<void> {
    await Promise.race([this.d.clock.sleep(ms), this.stopSignal]);
  }

  private async guard(what: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.d.log(`${what} failed: ${message(err)}`);
    }
  }

  private async every(ms: number, what: string, fn: () => Promise<unknown>): Promise<void> {
    while (!this.stopRequested) {
      await this.pause(ms);
      if (this.stopRequested) return;
      await this.guard(what, fn);
    }
  }

  private async pulse(): Promise<void> {
    this.d.systemd.watchdog();
    if (this.d.clock.now().getTime() - this.lastBeatMs >= HEARTBEAT_INTERVAL_MS) await this.heartbeat();
  }

  private async workerLoop(): Promise<void> {
    while (!this.stopRequested) {
      let ran = false;
      try {
        ran = await this.workerTick();
      } catch (err) {
        this.d.log(`worker failed: ${message(err)}`);
      }
      if (!ran) await this.pause(IDLE_POLL_MS);
    }
  }

  /**
   * The scheduler every 30 s (once at once), the worker (polling every 5 s when idle), the watchdog every 30 s and the
   * heartbeat every 15 min, until `requestStop`. Then the heartbeat says `stopped` and the singleton lock is let go.
   */
  async run(): Promise<void> {
    if (!this.stopRequested) {
      await this.guard('scheduler', () => this.schedulerTick());
      await Promise.all([
        this.every(SCHEDULER_INTERVAL_MS, 'scheduler', () => this.schedulerTick()),
        this.every(WATCHDOG_INTERVAL_MS, 'watchdog', () => this.pulse()),
        this.workerLoop(),
      ]);
    }
    this.state = 'stopped';
    this.currentJobId = null;
    await this.guard('heartbeat', () => this.heartbeat({ checkLock: false }));
    this.d.log('daemon stopped');
    const lock = this.lock;
    this.lock = null;
    if (lock) await lock.release().catch((err: unknown) => this.d.log(`releasing the daemon lock failed: ${message(err)}`));
    if (this.fatal) throw this.fatal;
  }
}
