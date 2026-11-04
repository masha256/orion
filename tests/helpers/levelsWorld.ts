import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import type { JobContext } from '../../src/daemon/daemon.js';
import { makeLevelsHandler, type LevelsHandlerOptions } from '../../src/daemon/jobs/levels.js';
import { enqueueJob, type Job } from '../../src/db/jobs.js';
import { insertRegistryRow } from '../../src/db/registry.js';
import type { OrionDb } from '../../src/db/connection.js';
import type { FetchDeps } from '../../src/ingest/run.js';
import { FakeClock } from './clock.js';

/** A config root with the given asset YAMLs, removed after the file. */
export function levelsWorld(yamls: Record<string, string>): { root: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), 'orion-levels-'));
  mkdirSync(join(root, 'assets'));
  for (const [id, text] of Object.entries(yamls)) writeFileSync(join(root, 'assets', `${id}.yaml`), text);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export function cleanupAfterAll(dirs: { cleanup(): void }[]): void {
  afterAll(() => {
    for (const d of dirs) d.cleanup();
  });
}

export async function activate(db: OrionDb, ids: string[]): Promise<void> {
  for (const id of ids) await insertRegistryRow(db, id, 'active', 'h', { at: '2026-09-01T00:00:00.000Z', by: 'test', reason: null, releaseTag: null });
}

export interface LevelsRun {
  posts: string[];
  pings: string[];
  enqueued: unknown[];
  ctx: JobContext;
}

/** A job context on `db` and `root` whose Slack and dead-man calls are recorded. */
export function levelsContext(db: OrionDb, root: string, now: Date | string, envVars: Record<string, string | undefined> = {}, post = true): LevelsRun {
  const posts: string[] = [];
  const pings: string[] = [];
  const enqueued: unknown[] = [];
  const ctx: JobContext = {
    db, clock: new FakeClock(now), env: 'dev', paths: { home: root, configRoot: root, envFile: join(root, 'no.env'), release: null },
    envVars, notify: { post: async (text) => (posts.push(text), { ok: post, attempts: 1 }) }, signal: new AbortController().signal,
    enqueue: async (j) => (enqueued.push(j), await enqueueJob(db, j)), log: () => undefined,
  };
  return { posts, pings, enqueued, ctx };
}

/** The levels handler with `deps` for every fetch and a dead-man fetch that records the URL and answers 200. */
export function handlerFor(run: LevelsRun, deps: FetchDeps, over: Partial<LevelsHandlerOptions> = {}) {
  return makeLevelsHandler({
    fetchDeps: () => deps,
    fetch: (async (url: string | URL | Request) => {
      run.pings.push(String(url));
      return new Response('ok', { status: 200 });
    }) as typeof fetch,
    ...over,
  });
}

export const levelsJob = (id: number, slot: string): Job =>
  ({ id, kind: 'levels', assetId: null, slot, status: 'running', attempts: 1, maxAttempts: 1 }) as Job;
