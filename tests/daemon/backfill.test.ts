import { copyFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fetchSummary } from '../../src/cli/util.js';
import { parseAssetYaml, type LoadedAsset } from '../../src/config/load.js';
import { defaultHandlers, type JobContext } from '../../src/daemon/daemon.js';
import {
  BACKFILL_CLEARANCE_MS, BACKFILL_DEFER_AFTER_MS, BACKFILL_MAX_DAYS, BACKFILL_NIGHTLY_RECHECK_MS, backfillHandler, makeBackfillHandler, parseBackfillParams,
  parsePricesBackfillParams, PRICES_BACKFILL_BUDGET_MS, PRICES_BACKFILL_MAX_DAYS, PRICES_BACKFILL_WATCH_MAX, PRICES_LOCK, pricesBackfillRequest,
} from '../../src/daemon/jobs/backfill.js';
import { REFRESH_LOCKED_RETRY_MS } from '../../src/daemon/jobs/refresh.js';
import type { Db } from '../../src/db/connection.js';
import { emptySourceOutcome } from '../../src/db/fetchRuns.js';
import { claimNextJob, deferJob, enqueueJob, getJob, LEASE_MS, PRICES_BACKFILL_MAX_ATTEMPTS, reapExpired, type Job } from '../../src/db/jobs.js';
import { callKey, fakeRpc, type FakeRpc } from '../helpers/fakeRpc.js';
import { loadPrices, type PriceEntry } from '../../src/prices/config.js';
import type { PriceDeps, WriteResult } from '../../src/prices/types.js';
import type { writeChainPrices } from '../../src/prices/writer.js';
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

// ---- op: prices (Phase 3 R2 Task 7) ---------------------------------------------------------------------------------

const PRICES = loadPrices(ROOT);
const bySymbol = (sym: string): PriceEntry => [...PRICES.values()].find((e) => e.symbol === sym)!;
const VVV = bySymbol('VVV');
const HOUR = 3_600_000;
const at = (iso: string) => Date.parse(iso);

// The Base chain of tests/prices/writer.test.ts (base-bnb.md, measured): 2 s blocks up to 53,556,127, then 0.2 s blocks
// sharing integer-second timestamps; VVV = Aerodrome v2 VVV/WETH reserves 1,000,000 : 6,467 x ETH 3,000, its v3 check
// at the tick for 19.40 USDC.
const SWITCH = 53_556_128n;
const baseTs = (n: bigint): number => (n < SWITCH ? 1_686_789_347 + 2 * Number(n) : 1_793_901_601 + Math.floor(Number(n - SWITCH) / 5));
const baseBlockAt = (t: number): bigint => (t <= 1_793_901_601 ? BigInt(Math.ceil((t - 1_686_789_347) / 2)) : SWITCH + BigInt(5 * (t - 1_793_901_601)));
const E18 = 10n ** 18n;
const k = (address: string, fn: string, args: readonly unknown[] = [], pick?: number) => callKey(address, fn, args) + (pick === undefined ? '' : `[${pick}]`);
const VVV_POOL = (VVV.primary as { pool: string }).pool.toLowerCase();
const VVV_CHECK_POOL = (VVV.check as { pool: string }).pool.toLowerCase();
const VVV_ADDR = VVV.ref.split('/')[1]!;
const TICK = BigInt(Math.round(Math.log(1e12 / 19.4) / Math.log(1.0001)));
function vvvCallsAt(n: bigint): Record<string, bigint> {
  const t = baseTs(n);
  const T = BigInt(t);
  const feed = (address: string, usd: number) => ({
    [k(address, 'latestRoundData', [], 1)]: BigInt(Math.round(usd * 1e8)), [k(address, 'latestRoundData', [], 3)]: BigInt(t - 60),
  });
  return {
    [k(VVV_POOL, 'token0')]: BigInt(VVV_ADDR), [k(VVV_POOL, 'token1')]: BigInt('0x4200000000000000000000000000000000000006'),
    [k(VVV_POOL, 'currentCumulativePrices', [], 0)]: 1_000_000n * E18 * T,
    [k(VVV_POOL, 'currentCumulativePrices', [], 1)]: 6_467n * E18 * T,
    [k(VVV_POOL, 'currentCumulativePrices', [], 2)]: T,
    [k(VVV_CHECK_POOL, 'token0')]: BigInt('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'), [k(VVV_CHECK_POOL, 'token1')]: BigInt(VVV_ADDR),
    [k(VVV_CHECK_POOL, 'observe', [[3600, 0]], 3)]: TICK * (T - 3600n),
    [k(VVV_CHECK_POOL, 'observe', [[3600, 0]], 4)]: TICK * T,
    ...feed('0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70', 3_000),
    ...feed('0x7e860098f58bbfc8648a4311b374b1d669a2bc6b', 1),
  };
}
const baseChain = (headIso: string): FakeRpc =>
  fakeRpc({ genesisTs: 1_686_789_347, latest: baseBlockAt(at(headIso) / 1000), blockTimeSec: 0.2, timestampOf: baseTs, callsAt: vvvCallsAt });
const unwired = new Proxy({}, { get: () => () => Promise.reject(new Error('not wired in this test')) });
const priceDepsOn = (rpc: FakeRpc) => (ctx: JobContext): PriceDeps => ({
  rpcFor: (chain) => {
    if (chain !== 'eip155:8453') throw new Error(`no fake rpc for ${chain}`);
    return rpc;
  },
  solana: unwired as PriceDeps['solana'], http: unwired as PriceDeps['http'], now: ctx.clock.now(), prices: PRICES,
});

/** A config root with the repo's schedule.yaml and prices.yaml (no asset needed: a prices backfill is not per asset). */
function pricesWorld(): { root: string } {
  const w = world();
  copyFileSync(join(ROOT, 'prices.yaml'), join(w.root, 'prices.yaml'));
  return w;
}
// Clear of the dev nightly (00:45Z): 2 h 45 min after it is the earliest a backfill starts; 20:45Z the latest.
const CLEAR = '2026-11-06T12:00:00.000Z';
const pricesJob = (params: unknown, id = 1, over: Partial<Job> = {}): Job =>
  ({ id, kind: 'backfill', assetId: null, slot: CLEAR, status: 'running', attempts: 1, maxAttempts: PRICES_BACKFILL_MAX_ATTEMPTS, params, result: null, leaseOwner: 'test', ...over }) as Job;

type Writer = typeof writeChainPrices;
const emptyResult = (refs: string[], over: Partial<WriteResult> = {}): WriteResult => ({
  written: Object.fromEntries(refs.map((r) => [r, 0])), skippedExisting: 0, missing: [], breaches: [], calls: {}, reachedMs: null,
  stoppedByBudget: false, stoppedBySignal: false, errors: [], ...over,
});
/** A writer that records its calls (and who held the `prices` run lock) and returns `result`. */
function fakeWriter(result: (refs: string[]) => WriteResult) {
  const calls: { refs: string[]; fromHourMs: number; toHourMs: number; budgetMs?: number; signal?: AbortSignal; lockHolder: string | null }[] = [];
  const fn: Writer = async (_db, _deps, refs, fromHourMs, toHourMs, opts = {}) => {
    const held = await testDb().assetRunLockHolder(PRICES_LOCK);
    calls.push({ refs, fromHourMs, toHourMs, budgetMs: opts.budgetMs, signal: opts.signal, lockHolder: held?.holder ?? null });
    return result(refs);
  };
  return { fn, calls };
}

describe('backfill op: prices (Phase 3 R2 Task 7)', () => {
  const TODAY = new Date('2026-11-14T10:00:00.000Z');

  it('prices: the constants; the enqueue check freezes to (default today), from <= to <= today, at most 550 days, refs in prices.yaml, nothing else', () => {
    // R28: 10 min a run, so a deploy drain (30 min wait) never times out behind one run (<= 10 min + one chain-day).
    expect(PRICES_BACKFILL_BUDGET_MS).toBe(10 * 60_000);
    expect(PRICES_BACKFILL_WATCH_MAX).toBe(20);
    // R27: op prices has its own cap; op fetch keeps 400.
    expect(PRICES_BACKFILL_MAX_DAYS).toBe(550);
    expect(BACKFILL_MAX_DAYS).toBe(400);
    // Item 5: not asset-shaped (ASSET_RE [a-z0-9-]), so an asset named `prices` never shares it.
    expect(PRICES_LOCK).toBe('job:prices');
    const ok = (raw: unknown) => pricesBackfillRequest(raw, PRICES, TODAY);
    const code = (raw: unknown): string => {
      try {
        ok(raw);
      } catch (err) {
        return `${(err as { code: string }).code}: ${(err as Error).message}`;
      }
      return '';
    };
    // R27 (a): no `to` -> today (UTC) at enqueue, stored, so the range never moves with a later run's day.
    expect(ok({ op: 'prices', from: '2025-10-13' })).toEqual({ op: 'prices', from: '2025-10-13', to: '2026-11-14' });
    expect(ok({ op: 'prices', from: '2026-11-01', to: '2026-11-14', refs: [VVV.ref, 'hyperliquid:spot/@107'] }))
      .toEqual({ op: 'prices', from: '2026-11-01', to: '2026-11-14', refs: [VVV.ref, 'hyperliquid:spot/@107'] });
    // 550 days, from..to inclusive: 2025-05-14..2026-11-14 is 550; one more is refused (R27 (c)).
    expect(ok({ op: 'prices', from: '2025-05-14', to: '2026-11-14' })).toMatchObject({ from: '2025-05-14' });
    expect(ok({ op: 'prices', from: '2025-05-14' })).toMatchObject({ from: '2025-05-14', to: '2026-11-14' });
    expect(code({ op: 'prices', from: '2025-05-13', to: '2026-11-14' })).toMatch(/^invalid_backfill_params: .*551 days.*at most 550/);
    expect(code({ op: 'prices', from: '2025-05-13' })).toMatch(/2025-05-13\.\.2026-11-14 is 551 days/);
    // The release command's range (deploy.md, M4) fits: 2025-10-13 + 549 days is 2027-04-15.
    expect(pricesBackfillRequest({ op: 'prices', from: '2025-10-13' }, PRICES, new Date('2027-04-15T23:00:00Z'))).toMatchObject({ to: '2027-04-15' });
    // The run-time parse (the handler's) checks the shape only: no span cap, no 'today' (R27 (b)).
    expect(parsePricesBackfillParams({ op: 'prices', from: '2024-01-01', to: '2026-11-14' }, PRICES)).toEqual({ op: 'prices', from: '2024-01-01', to: '2026-11-14' });
    expect(() => parsePricesBackfillParams({ op: 'prices', from: '2026-11-02', to: '2026-11-01' }, PRICES)).toThrow(/from 2026-11-02 is after to 2026-11-01/);
    expect(code({ op: 'prices', from: '2026-11-15' })).toMatch(/from 2026-11-15 is after today \(2026-11-14\)/);
    expect(code({ op: 'prices', from: '2026-11-10', to: '2026-11-15' })).toMatch(/to 2026-11-15 is after today \(2026-11-14\)/);
    expect(code({ op: 'prices', from: '2026-11-10', to: '2026-11-09' })).toMatch(/from 2026-11-10 is after to 2026-11-09/);
    for (const d of ['2026-13-01', '2026-02-30', '26-11-01', '2026-11-01T00:00:00Z', '', 20261101]) {
      expect(code({ op: 'prices', from: d }), String(d)).toMatch(/^invalid_backfill_params: from must be a YYYY-MM-DD day/);
    }
    expect(code({ op: 'prices' })).toMatch(/from must be a YYYY-MM-DD day/);
    expect(code({ op: 'prices', from: '2026-11-01', to: '2026/11/02' })).toMatch(/to must be a YYYY-MM-DD day/);
    expect(code({ op: 'prices', from: '2026-11-01', refs: ['eip155:1/0x0000000000000000000000000000000000000001'] }))
      .toBe('invalid_backfill_params: ref eip155:1/0x0000000000000000000000000000000000000001 is not in prices.yaml');
    expect(code({ op: 'prices', from: '2026-11-01', refs: [] })).toMatch(/refs must be a non-empty list/);
    expect(code({ op: 'prices', from: '2026-11-01', refs: [VVV.ref, VVV.ref] })).toMatch(/is listed twice/);
    expect(code({ op: 'prices', from: '2026-11-01', metrics: ['x'] })).toMatch(/unknown param "metrics"/);
    expect(code({ op: 'fetch', from: '2026-11-01' })).toMatch(/op must be "prices"/);
  });

  it('prices: one run writes [from 00:00Z, min(to + 1 day, the last completed hour)) for every ref by default, PRICES_BACKFILL_BUDGET_MS (10 min) a run, under the `job:prices` run lock', async () => {
    const w = pricesWorld();
    const run = levelsContext(testDb(), w.root, '2026-11-06T12:34:00.000Z');
    const f = fakeWriter((refs) => emptyResult(refs, { reachedMs: at('2026-11-04T00:00:00Z') }));
    const h = makeBackfillHandler({ writer: f.fn, priceDeps: priceDepsOn(baseChain(CLEAR)) });
    // to = today: the run stops at the top of the current hour (12:00Z).
    expect((await h(pricesJob({ op: 'prices', from: '2026-11-04' }), run.ctx)).status).toBe('done');
    // to in the past: to + 1 day.
    expect((await h(pricesJob({ op: 'prices', from: '2026-11-04', to: '2026-11-04', refs: [VVV.ref] }, 2), run.ctx)).status).toBe('done');
    expect(f.calls.map((c) => [c.refs, new Date(c.fromHourMs).toISOString(), new Date(c.toHourMs).toISOString(), c.budgetMs])).toEqual([
      [[...PRICES.keys()].sort(), '2026-11-04T00:00:00.000Z', '2026-11-06T12:00:00.000Z', 10 * 60_000],
      [[VVV.ref], '2026-11-04T00:00:00.000Z', '2026-11-05T00:00:00.000Z', PRICES_BACKFILL_BUDGET_MS],
    ]);
    expect(f.calls[0]!.signal).toBe(run.ctx.signal);
    expect(f.calls[0]!.lockHolder).toMatch(/^daemon backfill prices pid \d+$/);
    expect(await testDb().assetRunLockHolder(PRICES_LOCK)).toBeNull();
  });

  it('prices: defers while the nightly window is closed (Review Focus 4), and 30 min while another run holds the prices lock; nothing written', async () => {
    const w = pricesWorld();
    const f = fakeWriter((refs) => emptyResult(refs));
    const h = makeBackfillHandler({ writer: f.fn, priceDeps: priceDepsOn(baseChain(CLEAR)) });
    const late = levelsContext(testDb(), w.root, '2026-11-05T22:00:00.000Z');
    expect(await h(pricesJob({ op: 'prices', from: '2026-11-04' }), late.ctx)).toEqual({ status: 'deferred', untilMs: at('2026-11-06T02:45:00.000Z') });
    const during = levelsContext(testDb(), w.root, '2026-11-06T01:30:00.000Z');
    expect(await h(pricesJob({ op: 'prices', from: '2026-11-04' }), during.ctx)).toEqual({ status: 'deferred', untilMs: at('2026-11-06T02:45:00.000Z') });
    // The prices lock held by another process.
    const lock = await testDb().tryAssetRunLock(PRICES_LOCK, 'orion data reprice pid 1');
    const clear = levelsContext(testDb(), w.root, CLEAR);
    expect(await h(pricesJob({ op: 'prices', from: '2026-11-04' }), clear.ctx)).toEqual({ status: 'deferred', untilMs: at(CLEAR) + REFRESH_LOCKED_RETRY_MS });
    await lock!.release();
    expect(f.calls).toEqual([]);
    expect([...late.posts, ...during.posts, ...clear.posts]).toEqual([]);
  });

  it('prices: stopped by its budget it defers to now, keeping priority 70 (an hourly levels job runs between budgets); done once nothing is left', async () => {
    const w = pricesWorld();
    const rpc = baseChain(CLEAR);
    // budgetMs 0: each run commits one chain-day, newest first (the writer's own budget rule).
    const h = makeBackfillHandler({ priceDeps: priceDepsOn(rpc), pricesBudgetMs: 0 });
    const job = await enqueueJob(testDb(), { kind: 'backfill', assetId: null, slot: CLEAR, requestedBy: 'run-now:mike', params: { op: 'prices', from: '2026-11-04', to: '2026-11-05', refs: [VVV.ref] } });
    expect(job).toMatchObject({ priority: 70, maxAttempts: PRICES_BACKFILL_MAX_ATTEMPTS, assetId: null });
    const run = levelsContext(testDb(), w.root, CLEAR);
    const first = (await claimNextJob(testDb(), 'd1', new Date(CLEAR), null))!;
    const out = await h(first, run.ctx);
    expect(out).toEqual({ status: 'deferred', untilMs: at(CLEAR) });
    expect(run.posts).toEqual([]);
    await deferJob(testDb(), first.id, 'd1', new Date(at(CLEAR)));
    const after = (await getJob(testDb(), first.id))!;
    expect(after).toMatchObject({ status: 'queued', priority: 70, attempts: 0 });
    // The progress so far rides on the job row: one run, its calls.
    expect(after.result).toMatchObject({ op: 'prices', runs: 1, calls: { 'eip155:8453': expect.any(Number) } });
    // An hourly levels job due now runs first.
    await enqueueJob(testDb(), { kind: 'levels', assetId: null, slot: CLEAR });
    expect((await claimNextJob(testDb(), 'd1', new Date(CLEAR), null))!.kind).toBe('levels');
    const second = (await claimNextJob(testDb(), 'd1', new Date(CLEAR), null))!;
    expect(second.id).toBe(first.id);
    const done = await h(second, run.ctx);
    expect(done.status).toBe('done');
    const n = await testDb().one<{ n: number }>('SELECT count(*)::int AS n FROM prices WHERE token_ref = $1', [VVV.ref]);
    expect(n!.n).toBe(48);
    expect(run.posts).toHaveLength(1);
    expect(run.posts[0]).toMatch(new RegExp(
      '^ORION BACKFILL dev prices done in 0 min \\(2026-11-04\\.\\.2026-11-05, 2 runs\\): VVV 48 rows; oldest hour 2026-11-04T00:00:00\\.000Z; '
      + `missing none; calls eip155:8453 ${rpc.stats.multicall + rpc.stats.getBlock + 2}; breaches 0$`,
    ));
  });

  it('prices: a lease lost mid-day re-queues the job; the second run resumes from prices, skipping every committed chain-day (Review Focus 4)', async () => {
    const w = pricesWorld();
    const params = { op: 'prices' as const, from: '2026-11-04', to: '2026-11-05', refs: [VVV.ref] };
    await enqueueJob(testDb(), { kind: 'backfill', assetId: null, slot: CLEAR, params });
    const claimed = (await claimNextJob(testDb(), 'd1', new Date(CLEAR), null))!;
    // The lease goes while the second chain-day (2026-11-04) is in flight: 2026-11-05 is committed (24 hours, 25
    // multicalls: the cache carries B(H) into the older hour), the day in flight is not.
    const rpc1 = baseChain(CLEAR);
    const ac = new AbortController();
    const inner = rpc1.multicall.bind(rpc1);
    rpc1.multicall = async (calls, block) => {
      const out = await inner(calls, block);
      if (rpc1.stats.multicall === 28) ac.abort();
      return out;
    };
    const run1 = levelsContext(testDb(), w.root, CLEAR);
    const out1 = await makeBackfillHandler({ priceDeps: priceDepsOn(rpc1) })(claimed, { ...run1.ctx, signal: ac.signal });
    expect(out1).toEqual({ status: 'failed', result: null, error: 'aborted: the lease was lost' });
    expect(run1.posts).toEqual([]);
    const days = async () => await testDb().all<{ day: string; n: number }>(
      "SELECT to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*)::int AS n FROM prices WHERE token_ref = $1 GROUP BY 1 ORDER BY 1", [VVV.ref]);
    expect(await days()).toEqual([{ day: '2026-11-05', n: 24 }]);
    // Another daemon reaps the expired lease: the job is queued again (attempts remain), not failed.
    const reaped = await reapExpired(testDb(), new Date(at(CLEAR) + LEASE_MS + 1));
    expect(reaped.requeued.map((j) => j.id)).toEqual([claimed.id]);
    expect(reaped.failed).toEqual([]);
    const again = (await claimNextJob(testDb(), 'd2', new Date(at(CLEAR) + LEASE_MS + 1), null))!;
    expect(again).toMatchObject({ id: claimed.id, attempts: 2 });
    // The second run reads only the day that was not committed: 25 multicalls, none for 2026-11-05.
    const rpc2 = baseChain(CLEAR);
    const run2 = levelsContext(testDb(), w.root, CLEAR);
    const out2 = await makeBackfillHandler({ priceDeps: priceDepsOn(rpc2) })(again, run2.ctx);
    expect(out2.status).toBe('done');
    expect(rpc2.stats.multicall).toBe(25);
    expect(await days()).toEqual([{ day: '2026-11-04', n: 24 }, { day: '2026-11-05', n: 24 }]);
    expect(run2.posts).toHaveLength(1);
    expect(run2.posts[0]).toMatch(/^ORION BACKFILL dev prices done in 0 min \(2026-11-04\.\.2026-11-05, 1 run\): VVV 48 rows; oldest hour 2026-11-04T00:00:00\.000Z; /);
  });

  it('prices: stopped by its signal it posts nothing and saves nothing', async () => {
    const w = pricesWorld();
    const run = levelsContext(testDb(), w.root, CLEAR);
    const f = fakeWriter((refs) => emptyResult(refs, { stoppedBySignal: true }));
    const out = await makeBackfillHandler({ writer: f.fn, priceDeps: priceDepsOn(baseChain(CLEAR)) })(pricesJob({ op: 'prices', from: '2026-11-04' }), run.ctx);
    expect(out).toEqual({ status: 'failed', result: null, error: 'aborted: the lease was lost' });
    expect(run.posts).toEqual([]);
  });

  it('prices: done posts one line (rows per ref, oldest hour, missing by reason, calls per chain, breaches) and each breach as ORION WATCH, at most 20 a run plus one summary', async () => {
    const w = pricesWorld();
    const run = levelsContext(testDb(), w.root, CLEAR);
    const crv = bySymbol('CRV');
    const breaches = Array.from({ length: 23 }, (_, i) => ({ ref: crv.ref, hourMs: at('2026-11-04T00:00:00Z') + i * HOUR, gapPct: -1.7, check: 'chain:chainlink' }));
    const f = fakeWriter((refs) => emptyResult(refs, {
      reachedMs: at('2026-11-04T00:00:00Z'),
      missing: [
        { ref: VVV.ref, hourMs: at('2026-11-04T03:00:00Z'), reason: 'stale_swap' },
        { ref: VVV.ref, hourMs: at('2026-11-04T04:00:00Z'), reason: 'stale_swap' },
        { ref: crv.ref, hourMs: at('2026-11-04T05:00:00Z'), reason: 'no_quote' },
      ],
      calls: { 'eip155:1': 1200, 'eip155:8453': 30 },
      breaches,
    }));
    const out = await makeBackfillHandler({ writer: f.fn, priceDeps: priceDepsOn(baseChain(CLEAR)) })(
      pricesJob({ op: 'prices', from: '2026-11-04', to: '2026-11-05', refs: [crv.ref, VVV.ref] }), run.ctx);
    expect(out).toMatchObject({
      status: 'done',
      result: {
        op: 'prices', from: '2026-11-04', to: '2026-11-05', runs: 1, rows: { [crv.ref]: 0, [VVV.ref]: 0 }, reachedIso: '2026-11-04T00:00:00.000Z',
        missing: { stale_swap: 2, no_quote: 1 }, calls: { 'eip155:1': 1200, 'eip155:8453': 30 }, breaches: 23,
      },
    });
    const watch = (i: number) => `ORION WATCH dev price CRV ${new Date(at('2026-11-04T00:00:00Z') + i * HOUR).toISOString()}: -1.70% vs chain:chainlink`;
    expect(run.posts).toEqual([
      ...Array.from({ length: 20 }, (_, i) => watch(i)),
      'ORION WATCH dev price backfill: 3 more breaches not posted (23 this run); the prices rows carry check_gap_pct',
      'ORION BACKFILL dev prices done in 0 min (2026-11-04..2026-11-05, 1 run): CRV 0 rows, VVV 0 rows; oldest hour 2026-11-04T00:00:00.000Z; '
        + 'missing no_quote 1, stale_swap 2; calls eip155:1 1200, eip155:8453 30; breaches 23',
    ]);
    expect(await testDb().all('SELECT id FROM anomalies')).toEqual([]);
  });

  it('prices: a chain the writer stopped fails the job with one ALERT line (a re-queued job resumes)', async () => {
    const w = pricesWorld();
    const run = levelsContext(testDb(), w.root, CLEAR);
    const f = fakeWriter((refs) => emptyResult(refs, { errors: [{ chain: 'eip155:1', hourMs: at('2026-11-05T07:00:00Z'), error: 'timeout\nstack' }] }));
    const out = await makeBackfillHandler({ writer: f.fn, priceDeps: priceDepsOn(baseChain(CLEAR)) })(pricesJob({ op: 'prices', from: '2026-11-04' }), run.ctx);
    expect(out).toMatchObject({ status: 'failed', error: 'price_chain_stopped: eip155:1 stopped at 2026-11-05T07:00:00.000Z: timeout' });
    expect('retryAfterMs' in out).toBe(false);
    expect(run.posts).toEqual(['ORION ALERT dev backfill prices failed after 0 min: price_chain_stopped: eip155:1 stopped at 2026-11-05T07:00:00.000Z: timeout']);
  });

  it('prices: bad params, a prices job naming an asset, and a fetch job without one fail without writing', async () => {
    const w = pricesWorld();
    const run = levelsContext(testDb(), w.root, CLEAR);
    const f = fakeWriter((refs) => emptyResult(refs));
    const h = makeBackfillHandler({ writer: f.fn, priceDeps: priceDepsOn(baseChain(CLEAR)) });
    const bad = await h(pricesJob({ op: 'prices', from: '2026-11-04', refs: ['eip155:1/0x0000000000000000000000000000000000000001'] }), run.ctx);
    expect(bad).toMatchObject({ status: 'failed', error: 'invalid_backfill_params: ref eip155:1/0x0000000000000000000000000000000000000001 is not in prices.yaml' });
    const named = await h(pricesJob({ op: 'prices', from: '2026-11-04' }, 2, { assetId: 'mini' }), run.ctx);
    expect(named.status).toBe('failed');
    expect(await h(pricesJob(PARAMS, 3), run.ctx)).toMatchObject({ status: 'failed', error: 'a backfill job needs an asset' });
    expect(f.calls).toEqual([]);
  });
  it('prices: a stored job runs whatever its span is against today (R27: the span is checked at enqueue only)', async () => {
    const w = pricesWorld();
    const run = levelsContext(testDb(), w.root, CLEAR);
    const f = fakeWriter((refs) => emptyResult(refs));
    const h = makeBackfillHandler({ writer: f.fn, priceDeps: priceDepsOn(baseChain(CLEAR)) });
    // 2025-04-01..2026-11-05 is 584 days: over both caps, yet stored, so it runs.
    expect((await h(pricesJob({ op: 'prices', from: '2025-04-01', to: '2026-11-05', refs: [VVV.ref] }), run.ctx)).status).toBe('done');
    // A job stored without `to` (queued before R27) runs open-ended, to the last completed hour, whatever today is.
    expect((await h(pricesJob({ op: 'prices', from: '2025-04-01', refs: [VVV.ref] }, 2), run.ctx)).status).toBe('done');
    expect(f.calls.map((c) => [new Date(c.fromHourMs).toISOString(), new Date(c.toHourMs).toISOString()])).toEqual([
      ['2025-04-01T00:00:00.000Z', '2026-11-06T00:00:00.000Z'],
      ['2025-04-01T00:00:00.000Z', '2026-11-06T12:00:00.000Z'],
    ]);
    expect(run.posts.filter((p) => p.startsWith('ORION ALERT'))).toEqual([]);
  });

  it('prices: a run that uses its budget and has a chain error defers, and still posts and logs one ALERT line for the error', async () => {
    const w = pricesWorld();
    const run = levelsContext(testDb(), w.root, CLEAR);
    const logs: string[] = [];
    const ctx = { ...run.ctx, log: (line: string) => void logs.push(line) };
    const f = fakeWriter((refs) => emptyResult(refs, {
      stoppedByBudget: true, reachedMs: at('2026-11-05T00:00:00Z'),
      errors: [{ chain: 'eip155:1', hourMs: at('2026-11-05T07:00:00Z'), error: 'timeout\nstack' }],
    }));
    const out = await makeBackfillHandler({ writer: f.fn, priceDeps: priceDepsOn(baseChain(CLEAR)) })(pricesJob({ op: 'prices', from: '2026-11-04', to: '2026-11-05' }), ctx);
    expect(out).toEqual({ status: 'deferred', untilMs: at(CLEAR) });
    const alert = 'ORION ALERT dev backfill prices: price_chain_stopped: eip155:1 stopped at 2026-11-05T07:00:00.000Z: timeout; '
      + 'the job defers (budget used) and its next run reads the chain again';
    expect(run.posts).toEqual([alert]);
    expect(logs).toContain(alert);
  });

  it('prices: a later run that fails before the writer keeps the progress saved by the earlier runs', async () => {
    const w = pricesWorld();
    const run = levelsContext(testDb(), w.root, CLEAR);
    const f = fakeWriter((refs) => emptyResult(refs));
    const saved = { op: 'prices', runs: 2, workMs: 1_200_000, calls: { 'eip155:1': 900 }, written: { [VVV.ref]: 48 }, breaches: 3 };
    const out = await makeBackfillHandler({ writer: f.fn, priceDeps: priceDepsOn(baseChain(CLEAR)) })(
      pricesJob({ op: 'prices', from: '2026-11-04', refs: ['eip155:1/0x0000000000000000000000000000000000000001'] }, 1, { result: saved }), run.ctx);
    expect(out).toMatchObject({ status: 'failed', result: saved, error: expect.stringMatching(/^invalid_backfill_params: /) });
    expect(f.calls).toEqual([]);
  });

  it('prices: the run lock is `job:prices`, so a run lock held for an asset named `prices` does not block it', async () => {
    const w = pricesWorld();
    const run = levelsContext(testDb(), w.root, CLEAR);
    const f = fakeWriter((refs) => emptyResult(refs));
    const asset = await testDb().tryAssetRunLock('prices', 'orion tick pid 1');
    try {
      const out = await makeBackfillHandler({ writer: f.fn, priceDeps: priceDepsOn(baseChain(CLEAR)) })(pricesJob({ op: 'prices', from: '2026-11-04', to: '2026-11-05' }), run.ctx);
      expect(out.status).toBe('done');
    } finally {
      await asset!.release();
    }
    expect(f.calls.map((c) => c.lockHolder)).toEqual([expect.stringMatching(/^daemon backfill prices pid \d+$/)]);
  });
});
