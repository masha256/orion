import { copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fetchSummary } from '../../src/cli/util.js';
import { parseAssetYaml, type LoadedAsset } from '../../src/config/load.js';
import { defaultHandlers, type JobContext } from '../../src/daemon/daemon.js';
import {
  BACKFILL_CLEARANCE_MS, BACKFILL_DEFER_AFTER_MS, BACKFILL_MAX_DAYS, BACKFILL_NIGHTLY_RECHECK_MS, backfillHandler, makeBackfillHandler, parseBackfillParams,
} from '../../src/daemon/jobs/backfill.js';
import { REFRESH_LOCKED_RETRY_MS } from '../../src/daemon/jobs/refresh.js';
import type { Db } from '../../src/db/connection.js';
import { emptySourceOutcome } from '../../src/db/fetchRuns.js';
import { enqueueJob, type Job } from '../../src/db/jobs.js';
import { fetchAsset, type FetchDeps, type FetchOptions, type FetchResult } from '../../src/ingest/run.js';
import { sourceId } from '../../src/ingest/sourceId.js';
import { FakeClock } from '../helpers/clock.js';
import { MINI_ASSET_YAML } from '../helpers/assets.js';
import { harness } from '../helpers/fetchHarness.js';
import { useTestDb } from '../helpers/db.js';
import { INGEST_ASSET_YAML } from '../helpers/ingestAsset.js';
import { cleanupAfterAll, levelsContext, levelsWorld } from '../helpers/levelsWorld.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const testDb = useTestDb();
const worlds: { cleanup(): void }[] = [];
cleanupAfterAll(worlds);

const METRIC = 'flow_tokens.fees';
const PARAMS = { op: 'fetch', metrics: [METRIC], backfillDays: 3 };
const backfillJob = (params: unknown = PARAMS, id = 1): Job =>
  ({ id, kind: 'backfill', assetId: 'mini', slot: '2026-09-19T11:59:00.000Z', status: 'running', attempts: 1, maxAttempts: 1, params }) as Job;

/** A config root with the mini ingest asset and the repo's schedule.yaml (nightly 00:45Z; stage 02:45Z). The asset is not in the registry. */
function world(): { root: string } {
  const w = levelsWorld({ mini: INGEST_ASSET_YAML });
  worlds.push(w);
  copyFileSync(join(ROOT, 'schedule.yaml'), join(w.root, 'schedule.yaml'));
  return w;
}

type FetchFn = (db: Db, loaded: LoadedAsset, now: Date, deps: FetchDeps, opts?: FetchOptions) => Promise<FetchResult>;

/** A fetch that records what it was asked and who held the asset's run lock meanwhile, then runs `inner`. */
function recordingFetch(inner: FetchFn = fetchAsset) {
  const calls: { metrics?: string[]; backfillDays?: number; lockHolder: string | null; result?: FetchResult }[] = [];
  const fn: FetchFn = async (db, loaded, now, deps, opts = {}) => {
    const held = await testDb().assetRunLockHolder(loaded.config.id);
    const call: (typeof calls)[number] = { metrics: opts.metrics, backfillDays: opts.backfillDays, lockHolder: held?.holder ?? null };
    calls.push(call);
    call.result = await inner(db, loaded, now, deps, opts);
    return call.result;
  };
  return { fn, calls };
}

function handlerIn(ctx: JobContext, fetch: FetchFn) {
  const h = harness(testDb(), { now: ctx.clock.now() });
  return makeBackfillHandler({ fetchDeps: () => h.deps, fetch });
}

describe('backfill job', () => {
  it('backfill: the constants are the plan\'s; the daemon runs the backfill handler', () => {
    expect(BACKFILL_CLEARANCE_MS).toBe(4 * 3_600_000);
    expect(BACKFILL_DEFER_AFTER_MS).toBe(2 * 3_600_000);
    expect(BACKFILL_MAX_DAYS).toBe(400);
    expect(defaultHandlers().backfill).toBe(backfillHandler);
  });

  it("backfill: runs fetchAsset with the job's metrics and backfillDays under the asset run lock", async () => {
    const w = world();
    const run = levelsContext(testDb(), w.root, '2026-09-19T12:00:00.000Z');
    // The scan takes 65 min; the start line is posted before it begins (under the lock).
    const startPosts: string[][] = [];
    const f = recordingFetch(async (db, loaded, now, deps, opts) => {
      startPosts.push([...run.posts]);
      (run.ctx.clock as FakeClock).advance(65 * 60_000);
      return await fetchAsset(db, loaded, now, deps, opts);
    });
    const out = await handlerIn(run.ctx, f.fn)(backfillJob(), run.ctx);
    expect(startPosts).toEqual([[`ORION BACKFILL dev MINI started: ${METRIC}, 3 days`]]);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ metrics: [METRIC], backfillDays: 3 });
    expect(f.calls[0]!.lockHolder).toMatch(/^daemon backfill pid \d+$/);
    const fetched = f.calls[0]!.result!;
    expect(fetched.dryRun).toBe(false);
    const rows = fetched.written.filter((x) => x.metricKey === METRIC).length;
    expect(rows).toBeGreaterThan(0);
    expect(out).toEqual({ status: 'done', result: { fetchLines: fetchSummary(fetched), written: { [METRIC]: rows } } });
    expect(run.posts).toEqual([`ORION BACKFILL dev MINI started: ${METRIC}, 3 days`, `ORION BACKFILL dev MINI done in 1 h 05 min (3 days): ${METRIC} ${rows} rows`]);
    // The lock is let go afterwards.
    expect(await testDb().assetRunLockHolder('mini')).toBeNull();
  });

  it('backfill: defers when the next nightly slot is under 4 h away, or the last one began under 2 h ago', async () => {
    const w = world();
    const f = recordingFetch();
    // 22:00Z, nightly at 00:45Z: 2 h 45 min away, so wait until 2 h after that slot.
    const late = levelsContext(testDb(), w.root, '2026-09-19T22:00:00.000Z');
    expect(await handlerIn(late.ctx, f.fn)(backfillJob(), late.ctx)).toEqual({ status: 'deferred', untilMs: Date.parse('2026-09-20T02:45:00.000Z') });
    // 01:30Z: the 00:45Z nightly is still running its refreshes.
    const during = levelsContext(testDb(), w.root, '2026-09-20T01:30:00.000Z');
    expect(await handlerIn(during.ctx, f.fn)(backfillJob(), during.ctx)).toEqual({ status: 'deferred', untilMs: Date.parse('2026-09-20T02:45:00.000Z') });
    // Staging's nightly is 02:45Z: at 22:00Z it is 4 h 45 min away (runs); at 23:00Z 3 h 45 min (defers to 04:45Z).
    const stageLate = levelsContext(testDb(), w.root, '2026-09-19T23:00:00.000Z');
    const stageCtx: JobContext = { ...stageLate.ctx, env: 'stage' };
    expect(await handlerIn(stageCtx, f.fn)(backfillJob(), stageCtx)).toEqual({ status: 'deferred', untilMs: Date.parse('2026-09-20T04:45:00.000Z') });
    expect(f.calls).toEqual([]);
    expect([...late.posts, ...during.posts, ...stageLate.posts]).toEqual([]);
    // 4 h before the slot exactly is clear; so is 2 h after it.
    const edge = levelsContext(testDb(), w.root, '2026-09-19T20:45:00.000Z');
    expect((await handlerIn(edge.ctx, f.fn)(backfillJob(), edge.ctx)).status).toBe('done');
    const after = levelsContext(testDb(), w.root, '2026-09-20T02:45:00.000Z');
    expect((await handlerIn(after.ctx, f.fn)(backfillJob(undefined, 2), after.ctx)).status).toBe('done');
    expect(f.calls).toHaveLength(2);
  });

  it('backfill: fails without retry on a fetch error, posting one line naming the asset, the metrics and the error', async () => {
    const w = world();
    const run = levelsContext(testDb(), w.root, '2026-09-19T12:00:00.000Z');
    const f = recordingFetch(async () => {
      (run.ctx.clock as FakeClock).advance(2 * 60_000);
      throw new Error('eth_getLogs refused: range too large\n    at scan (rpc.ts:1)');
    });
    const job = backfillJob({ op: 'fetch', metrics: [METRIC, 'flow_usd.fees'], backfillDays: 120 });
    const out = await handlerIn(run.ctx, f.fn)(job, run.ctx);
    expect(out).toEqual({ status: 'failed', result: { fetchLines: [], written: {} }, error: 'Error: eth_getLogs refused: range too large' });
    expect('retryAfterMs' in out).toBe(false);
    expect(run.posts).toEqual([
      `ORION BACKFILL dev MINI started: ${METRIC}, flow_usd.fees, 120 days`,
      `ORION ALERT dev backfill MINI ${METRIC}, flow_usd.fees failed after 2 min: Error: eth_getLogs refused: range too large`,
    ]);

    // A fetch whose every source failed is a failure too: the first failed source's error, first line.
    const failedFetch = recordingFetch(async (_db, loaded, now) => ({
      assetId: loaded.config.id, dryRun: false, fetchRunId: 9, outcome: 'failed', startedAt: now.toISOString(), endedAt: now.toISOString(),
      sources: [{ ...emptySourceOutcome('chain:transfer_flow'), status: 'failed', error: 'could not read the latest block: timeout\nmore' }],
      written: [], anomalies: [], watch: [],
    }));
    const run2 = levelsContext(testDb(), w.root, '2026-09-19T12:00:00.000Z');
    const out2 = await handlerIn(run2.ctx, failedFetch.fn)(backfillJob(), run2.ctx);
    expect(out2).toMatchObject({ status: 'failed', error: 'fetch_failed: chain:transfer_flow: could not read the latest block: timeout' });
    expect('retryAfterMs' in out2).toBe(false);
    expect((out2 as { result: { fetchLines: string[] } }).result.fetchLines[0]).toBe('MINI fetch failed');
    expect(run2.posts).toEqual([
      `ORION BACKFILL dev MINI started: ${METRIC}, 3 days`,
      `ORION ALERT dev backfill MINI ${METRIC} failed after 0 min: fetch_failed: chain:transfer_flow: could not read the latest block: timeout`,
    ]);
  });

  it("backfill: refuses params that don't parse, and fetches nothing", async () => {
    const w = world();
    const run = levelsContext(testDb(), w.root, '2026-09-19T12:00:00.000Z');
    const f = recordingFetch();
    const handler = handlerIn(run.ctx, f.fn);
    const bad: unknown[] = [
      null,
      { metrics: [METRIC], backfillDays: 3 }, // no op
      { op: 'prices', metrics: [METRIC], backfillDays: 3 }, // not an op of this release
      { op: 'fetch', metrics: ['nope'], backfillDays: 3 }, // not configured
      { op: 'fetch', metrics: ['total_supply'], backfillDays: 3 }, // a level, not a flow
      { op: 'fetch', metrics: [], backfillDays: 3 },
      { op: 'fetch', metrics: [METRIC, METRIC], backfillDays: 3 },
      { op: 'fetch', metrics: [METRIC], backfillDays: 0 },
      { op: 'fetch', metrics: [METRIC], backfillDays: 401 },
      { op: 'fetch', metrics: [METRIC], backfillDays: 2.5 },
      { op: 'fetch', metrics: [METRIC], backfillDays: 3, extra: true },
    ];
    for (const params of bad) {
      const out = await handler(backfillJob(params), run.ctx);
      expect(out, JSON.stringify(params)).toMatchObject({ status: 'failed', error: expect.stringMatching(/^invalid_backfill_params: /) });
      expect('retryAfterMs' in out).toBe(false);
    }
    expect(f.calls).toEqual([]);
    expect(run.posts).toHaveLength(bad.length);
    expect(run.posts[3]).toBe('ORION ALERT dev backfill MINI failed: invalid_backfill_params: metric "nope" is not defined in assets/mini.yaml');

    // The validator on its own (the CLI uses it too): 400 days is the cap; a flow entered by hand has no source to re-scan.
    const loaded = parseAssetYaml(INGEST_ASSET_YAML);
    expect(parseBackfillParams({ op: 'fetch', metrics: [METRIC], backfillDays: BACKFILL_MAX_DAYS }, loaded.config)).toEqual({ op: 'fetch', metrics: [METRIC], backfillDays: 400 });
    expect(() => parseBackfillParams({ op: 'fetch', metrics: ['total_supply'], backfillDays: 3 }, loaded.config)).toThrow(
      expect.objectContaining({ code: 'invalid_backfill_params', message: 'metric "total_supply" is a level, not a flow: only flows are backfilled' }),
    );
    const manual = parseAssetYaml(MINI_ASSET_YAML).config;
    expect(() => parseBackfillParams({ op: 'fetch', metrics: ['flow_usd.fees'], backfillDays: 3 }, manual)).toThrow(
      expect.objectContaining({ code: 'invalid_backfill_params', message: expect.stringContaining('has no source') }),
    );
  });

  it('backfill: run_in_progress (the asset run lock held) defers 30 min, like refresh', async () => {
    const w = world();
    const run = levelsContext(testDb(), w.root, '2026-09-19T12:00:00.000Z');
    const f = recordingFetch();
    const lock = await testDb().tryAssetRunLock('mini', 'orion tick pid 7');
    expect(lock).not.toBeNull();
    try {
      const out = await handlerIn(run.ctx, f.fn)(backfillJob(), run.ctx);
      expect(out).toEqual({ status: 'deferred', untilMs: Date.parse('2026-09-19T12:00:00.000Z') + REFRESH_LOCKED_RETRY_MS });
    } finally {
      await lock!.release();
    }
    expect(f.calls).toEqual([]);
    expect(run.posts).toEqual([]);
  });

  it("backfill: waits while a refresh or the report of the newest nightly slot is unfinished, past the slot's 2 h", async () => {
    const w = world();
    const slot = '2026-09-20T00:45:00.000Z';
    const at = '2026-09-20T03:15:00.000Z'; // slot + 2 h 30 min: the clock-only window is open
    const f = recordingFetch();
    // A refresh retry of the slot, queued for 03:25Z (a failed first attempt, +10 min): the backfill waits 15 min.
    const retry = await enqueueJob(testDb(), { kind: 'refresh', assetId: 'mini', slot, runAfter: '2026-09-20T03:25:00.000Z' });
    const done = await enqueueJob(testDb(), { kind: 'refresh', assetId: 'other', slot });
    const report = await enqueueJob(testDb(), { kind: 'nightly_report', assetId: null, slot });
    await testDb().run("UPDATE jobs SET status = 'done' WHERE id = $1", [done!.id]);
    await testDb().run("UPDATE jobs SET status = 'running' WHERE id = $1", [report!.id]);
    // A queued refresh of an OLDER slot does not hold the backfill (only the newest nightly slot counts).
    await enqueueJob(testDb(), { kind: 'refresh', assetId: 'mini', slot: '2026-09-19T00:45:00.000Z' });
    const recheck = Date.parse(at) + BACKFILL_NIGHTLY_RECHECK_MS;
    expect(BACKFILL_NIGHTLY_RECHECK_MS).toBe(15 * 60_000);
    const r1 = levelsContext(testDb(), w.root, at);
    expect(await handlerIn(r1.ctx, f.fn)(backfillJob(), r1.ctx)).toEqual({ status: 'deferred', untilMs: recheck });
    // The retry finished; the report is still running (waiting for refreshes, or posting): still waits.
    await testDb().run("UPDATE jobs SET status = 'failed' WHERE id = $1", [retry!.id]);
    const r2 = levelsContext(testDb(), w.root, at);
    expect(await handlerIn(r2.ctx, f.fn)(backfillJob(), r2.ctx)).toEqual({ status: 'deferred', untilMs: recheck });
    expect(f.calls).toEqual([]);
    expect([...r1.posts, ...r2.posts]).toEqual([]);
    // Every job of the slot finished (done, failed or skipped): the backfill runs.
    await testDb().run("UPDATE jobs SET status = 'skipped' WHERE id = $1", [report!.id]);
    const r3 = levelsContext(testDb(), w.root, at);
    expect((await handlerIn(r3.ctx, f.fn)(backfillJob(), r3.ctx)).status).toBe('done');
    expect(f.calls).toHaveLength(1);
  });

  it("backfill: a partial fetch whose failed source is a requested metric's primary fails the job; a failed check alone does not", async () => {
    const w = world();
    const config = parseAssetYaml(INGEST_ASSET_YAML).config;
    const primary = sourceId(config.metrics[METRIC]!.source!);
    const check = sourceId(config.metrics['flow_usd.fees']!.cross_checks![0]!.source);
    /** The real fetch, then `id` marked failed and the outcome partial. */
    const failing = (id: string, error: string) => recordingFetch(async (db, loaded, now, deps, opts) => {
      const r = await fetchAsset(db, loaded, now, deps, opts);
      // The source is one the fetch really ran (the plan for these metrics includes it).
      expect(r.sources.map((s) => s.sourceId)).toContain(id);
      const sources = r.sources.map((s) => (s.sourceId === id ? { ...s, status: 'failed' as const, error } : s));
      return { ...r, outcome: 'partial', sources };
    });
    const params = { op: 'fetch', metrics: [METRIC, 'flow_usd.fees'], backfillDays: 3 };

    // The primary of a requested metric failed: the request was not done. Failed, one ALERT, no retry.
    const run = levelsContext(testDb(), w.root, '2026-09-19T12:00:00.000Z');
    const f = failing(primary, 'eth_getLogs: 429 Too Many Requests\nat scan');
    const out = await handlerIn(run.ctx, f.fn)(backfillJob(params), run.ctx);
    expect(out).toMatchObject({ status: 'failed', error: `fetch_partial: ${primary}: eth_getLogs: 429 Too Many Requests` });
    expect('retryAfterMs' in out).toBe(false);
    const res = (out as { result: { fetchLines: string[]; written: Record<string, number> } }).result;
    expect(res.fetchLines).toEqual(fetchSummary(f.calls[0]!.result!));
    expect(Object.keys(res.written)).toEqual([METRIC, 'flow_usd.fees']);
    expect(run.posts).toEqual([
      `ORION BACKFILL dev MINI started: ${METRIC}, flow_usd.fees, 3 days`,
      `ORION ALERT dev backfill MINI ${METRIC}, flow_usd.fees failed after 0 min: fetch_partial: ${primary}: eth_getLogs: 429 Too Many Requests`,
    ]);

    // Only a cross-check source failed: the rows were written, so done, and the line names the failed check.
    const run2 = levelsContext(testDb(), w.root, '2026-09-19T12:00:00.000Z');
    const g = failing(check, 'HTTP 502');
    const out2 = await handlerIn(run2.ctx, g.fn)(backfillJob(params, 2), run2.ctx);
    expect(out2.status).toBe('done');
    const rows = (out2 as { result: { written: Record<string, number> } }).result.written;
    expect(run2.posts).toEqual([
      `ORION BACKFILL dev MINI started: ${METRIC}, flow_usd.fees, 3 days`,
      `ORION BACKFILL dev MINI done in 0 min (3 days): ${METRIC} ${rows[METRIC]} rows, flow_usd.fees ${rows['flow_usd.fees']} rows; partial: ${check} failed`,
    ]);
  });

  it('backfill: a job without an asset fails', async () => {
    const w = world();
    const run = levelsContext(testDb(), w.root, '2026-09-19T12:00:00.000Z');
    const out = await handlerIn(run.ctx, recordingFetch().fn)({ ...backfillJob(), assetId: null }, run.ctx);
    expect(out).toMatchObject({ status: 'failed', error: 'a backfill job needs an asset' });
  });
});
