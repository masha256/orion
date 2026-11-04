import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import type { Job } from '../../db/jobs.js';
import { listRegistry } from '../../db/registry.js';
import {
  insertSnapshot, latestPushed, markAlerted, markPushFailed, markPushed, pendingSnapshots, type OutboxRow,
} from '../../db/snapshotsOut.js';
import { assetsFile, levelsBody } from '../../push/body.js';
import { buildEnvelope, buildFileSet, type SnapshotKind } from '../../push/envelope.js';
import { runGit, type GitRun } from '../../push/gitPublisher.js';
import { checkPublishTarget, publisherFromEnv, PUBLISH_OFF, type Publisher } from '../../push/publisher.js';
import { OrionError } from '../../types.js';
import type { JobContext, JobHandler, JobOutcome } from '../daemon.js';

/** Retry delays after the 1st, 2nd and 3rd failed attempt of the oldest pending snapshot; hourly after that. */
export const PUSH_BACKOFF_MIN = [1, 5, 15] as const;
export const PUSH_BACKOFF_LATER_MIN = 60;
/** An unpushed snapshot this old is alerted (once). */
export const PUSH_ALERT_AFTER_MS = 3 * 3_600_000;
/** Failures alerted at the first attempt: they need a human, waiting does not help. */
const ALERT_AT_ONCE = new Set(['publish_remote_moved', 'publish_repo_is_prod', 'publish_repo_is_stage', 'publish_dir_mismatch']);
const ERROR_MAX = 1000;

export interface SnapshotPushOptions {
  /** Default: the publisher `ORION_PUBLISH` names (null = publishing off). */
  publisher?: (ctx: JobContext) => Publisher | null;
  run?: GitRun;
  /** For the commit author `orion-<env>@<host>`. Default: this host's name. */
  host?: string;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const aborted: JobOutcome = { status: 'failed', result: null, error: 'aborted: the lease was lost' };

/** Stores a snapshot of `kind` in the outbox, enveloped for this job's env and release. A `snapshot_push` must follow. */
export async function recordSnapshot(ctx: JobContext, kind: SnapshotKind, body: unknown, day: string | null): Promise<OutboxRow> {
  const envelope = buildEnvelope(kind, body, { seq: 0, env: ctx.env, releaseTag: ctx.paths.release?.tag ?? null, now: ctx.clock.now() });
  return await insertSnapshot(ctx.db, { kind, day, envelope });
}

/** The levels job's `onLevels` hook: a `levels` snapshot of every active and paused asset's `latest_levels`. */
export async function levelsSnapshot(ctx: JobContext): Promise<void> {
  await recordSnapshot(ctx, 'levels', await levelsBody(ctx.db, await listRegistry(ctx.db)), null);
}

function signKey(envVars: Record<string, string | undefined>): string {
  const file = (envVars.ORION_SIGN_KEY_FILE ?? '').trim();
  if (file === '') throw new OrionError('sign_key_missing', 'ORION_PUBLISH is set but ORION_SIGN_KEY_FILE is not: manifests must be signed');
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    throw new OrionError('sign_key_missing', `ORION_SIGN_KEY_FILE ${file} cannot be read: ${(err as NodeJS.ErrnoException).code ?? message(err)}`);
  }
}

const describe = (row: OutboxRow, releaseTag: string | null): string => `${row.kind} seq ${row.seq} day ${row.day ?? '-'} release ${releaseTag ?? '-'}`;
const newest = (rows: OutboxRow[], kind: SnapshotKind): OutboxRow | null =>
  rows.filter((r) => r.kind === kind).reduce<OutboxRow | null>((a, r) => (a === null || r.seq > a.seq ? r : a), null);

/**
 * The `snapshot_push` job (spec 9.2): publishes the newest pending (else newest pushed) snapshot of each kind plus
 * `assets.json`, once, and marks every pending row it covered pushed. Publishing off (`ORION_PUBLISH` unset): skipped,
 * rows stay pending. On failure the rows keep their place in the outbox (nothing is recomputed), a retry is queued
 * 1, 5, 15 min and then hourly after the oldest pending row's 1st, 2nd, 3rd and later attempts, and one ALERT is posted
 * when that row is 3 h old (at once for a moved remote or a wrong repo).
 */
export function makeSnapshotPushHandler(o: SnapshotPushOptions = {}): JobHandler {
  return async (_job: Job, ctx) => {
    if (ctx.signal.aborted) return aborted;
    const { db, envVars } = ctx;
    const pending = await pendingSnapshots(db);
    const target = (envVars.ORION_PUBLISH ?? '').trim();
    if (target === '' || target === PUBLISH_OFF) {
      return { status: 'skipped', result: { reason: `publishing off (ORION_PUBLISH ${target === '' ? 'unset' : 'off'})`, pending: pending.length } };
    }
    if (pending.length === 0) return { status: 'done', result: { pushed: 0 } };
    const now = ctx.clock.now();
    const releaseTag = ctx.paths.release?.tag ?? null;
    const ids = pending.map((r) => r.id);
    try {
      checkPublishTarget(ctx.env, envVars.ORION_PUBLISH);
      const publisher = o.publisher
        ? o.publisher(ctx)
        : publisherFromEnv(envVars, ctx.paths, o.run ?? runGit, { env: ctx.env, host: o.host ?? hostname() });
      if (publisher === null) return { status: 'skipped', result: { reason: 'publishing off', pending: pending.length } };
      const full = newest(pending, 'full') ?? (await latestPushed(db, 'full'));
      const levels = newest(pending, 'levels') ?? (await latestPushed(db, 'levels'));
      const files = buildFileSet({ full, levels, assets: assetsFile(await listRegistry(db)), env: ctx.env, releaseTag, now }, signKey(envVars));
      const lead = newest(pending, 'full') ?? newest(pending, 'levels')!;
      if (ctx.signal.aborted) return aborted;
      const { ref } = await publisher.publish(files, describe(lead, releaseTag));
      if (ctx.signal.aborted) return aborted;
      await markPushed(db, ids, now.toISOString());
      return { status: 'done', result: { pushed: ids.length, ref, full: full?.seq ?? null, levels: levels?.seq ?? null } };
    } catch (err) {
      if (ctx.signal.aborted) return aborted;
      const error = message(err).slice(0, ERROR_MAX);
      await markPushFailed(db, ids, error);
      const oldest = pending[0];
      const attempts = oldest.attempts + 1;
      const waitMin = PUSH_BACKOFF_MIN[attempts - 1] ?? PUSH_BACKOFF_LATER_MIN;
      const retryAt = new Date(now.getTime() + waitMin * 60_000).toISOString();
      await ctx.enqueue({ kind: 'snapshot_push', assetId: null, slot: retryAt, requestedBy: 'snapshot_push retry' });
      let alerted = false;
      const atOnce = err instanceof OrionError && ALERT_AT_ONCE.has(err.code);
      if (oldest.alertedAt === null && (atOnce || now.getTime() - Date.parse(oldest.createdAt) >= PUSH_ALERT_AFTER_MS)) {
        const text = `ORION ALERT ${ctx.env} snapshot publish failing since ${oldest.createdAt}: ${error}`;
        ctx.log(text);
        alerted = (await ctx.notify.post(text)).ok;
        if (alerted) await markAlerted(db, ids, now.toISOString());
      }
      return { status: 'failed', result: { pending: ids.length, attempts, retryAt, alerted }, error };
    }
  };
}

export const snapshotPushHandler: JobHandler = makeSnapshotPushHandler();
