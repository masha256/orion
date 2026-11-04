import { join } from 'node:path';
import type { JobContext } from '../../src/daemon/daemon.js';
import type { Job, NewJob } from '../../src/db/jobs.js';
import type { Db } from '../../src/db/connection.js';
import type { ReleaseInfo } from '../../src/cli/paths.js';
import { FakeClock } from './clock.js';

export interface PushRun {
  posts: string[];
  enqueued: NewJob[];
  ctx: JobContext;
}

/** A stage job context on `db` whose Slack posts and enqueues are recorded (enqueue writes nothing). */
export function pushContext(db: Db, home: string, now: string, envVars: Record<string, string | undefined>, release: ReleaseInfo | null = { tag: 'orion-2026.11.03.1', commit: 'c', schema: 2, builtAt: 'b' }): PushRun {
  const posts: string[] = [];
  const enqueued: NewJob[] = [];
  const ctx: JobContext = {
    db, clock: new FakeClock(now), env: 'stage', paths: { home, configRoot: home, envFile: join(home, 'no.env'), release },
    envVars, notify: { post: async (text) => (posts.push(text), { ok: true, attempts: 1 }) }, signal: new AbortController().signal,
    enqueue: async (j) => (enqueued.push(j), null), log: () => undefined,
  };
  return { posts, enqueued, ctx };
}

export const pushJob = (id: number, slot = '2026-11-03T01:15:00.000Z'): Job =>
  ({ id, kind: 'snapshot_push', assetId: null, slot, status: 'running', attempts: 1, maxAttempts: 1 }) as Job;
