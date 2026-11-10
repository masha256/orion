import { describe, expect, it } from 'vitest';
import type { TickDeps, TickResult } from '../../src/app/tick.js';
import type { TickReport } from '../../src/app/tickReport.js';
import { defaultHandlers } from '../../src/daemon/daemon.js';
import { makeRefreshHandler, refreshHandler, REFRESH_RETRY_MS, REFRESH_LOCKED_RETRY_MS } from '../../src/daemon/jobs/refresh.js';
import type { Job } from '../../src/db/jobs.js';
import { listLatestLevels } from '../../src/db/latestLevels.js';
import { getRegistryRow, setRegistryState } from '../../src/db/registry.js';
import { listWatchStates, putWatchStates } from '../../src/db/watchState.js';
import { harness, NOW } from '../helpers/fetchHarness.js';
import { useTestDb } from '../helpers/db.js';
import { INGEST_ASSET_YAML, METRICS_END } from '../helpers/ingestAsset.js';
import { activate, cleanupAfterAll, levelsContext, levelsWorld } from '../helpers/levelsWorld.js';

const testDb = useTestDb();
const worlds: { cleanup(): void }[] = [];
cleanupAfterAll(worlds);

const SLOT = '2026-09-19T00:45:00.000Z';
const refreshJob = (attempts = 1, id = 1): Job =>
  ({ id, kind: 'refresh', assetId: 'mini', slot: SLOT, status: 'running', attempts, maxAttempts: 2 }) as Job;

async function world() {
  const w = levelsWorld({ mini: INGEST_ASSET_YAML });
  worlds.push(w);
  await activate(testDb(), ['mini']);
  return w;
}

function report(over: Partial<TickReport> = {}): TickReport {
  return {
    schema_version: 2, tick_id: 'tick_mini', asset: 'mini', started_at: NOW.toISOString(), ended_at: NOW.toISOString(), outcome: 'completed',
    lock: null, ingest: { fetch_run_id: 1, outcome: 'ok', sources_failed: [], anomalies_raised: [] }, holder_yield: null, report_error: null,
    inbox: { observations: [], proposals: [], anomalies: [] }, error: null, ...over,
  };
}

/** A tickAsset stand-in returning `r`, recording the deps it was given. */
function fakeTick(r: TickResult, seen: TickDeps[] = []) {
  return async (_db: unknown, _loaded: unknown, deps: TickDeps): Promise<TickResult> => {
    seen.push(deps);
    return r;
  };
}

describe('refresh job', () => {
  it('refresh: a paused asset is skipped', async () => {
    const w = await world();
    await setRegistryState(testDb(), 'mini', 'active', 'paused', { at: '2026-09-18T00:00:00.000Z', by: 't', reason: 'x', releaseTag: null });
    const run = levelsContext(testDb(), w.root, NOW);
    const h = harness(testDb());
    let ticked = 0;
    const handler = makeRefreshHandler({ fetchDeps: () => h.deps, tick: async () => { ticked++; throw new Error('not reached'); } });
    expect(await handler(refreshJob(), run.ctx)).toEqual({ status: 'skipped', result: { reason: 'paused' } });
    expect(ticked).toBe(0);
    await testDb().run("DELETE FROM asset_registry WHERE asset_id = 'mini'");
    expect(await handler(refreshJob(), run.ctx)).toEqual({ status: 'skipped', result: { reason: 'missing' } });
  });

  it('refresh: exit 2 is done with report_error kept', async () => {
    const w = await world();
    const run = levelsContext(testDb(), w.root, NOW);
    const h = harness(testDb());
    const stale = report({ report_error: { code: 'report_stale', message: 'holder-yield report day 2026-09-10 is 9 days behind' } });
    const seen: TickDeps[] = [];
    const cache = new Map<string, Promise<unknown>>();
    const out = await makeRefreshHandler({ fetchDeps: () => h.deps, tick: fakeTick({ report: stale, exitCode: 2 }, seen) })(
      refreshJob(), { ...run.ctx, sharedHttpCache: (slot) => (slot === SLOT ? cache : new Map()) },
    );
    expect(out).toEqual({ status: 'done', result: { report: stale, fetchLines: [], alertFlags: [], levels: 0 } });
    // The nightly's shared chart cache and the day-boundary block cache are handed to the fetch.
    expect(seen[0]!.fetchDeps.sharedHttpCache).toBe(cache);
    expect(typeof seen[0]!.fetchDeps.dayBlocks).toBe('function');
    expect(seen[0]!.home).toBe(w.root);
    expect(await getRegistryRow(testDb(), 'mini')).toMatchObject({ lastJobId: 1, lastRunAt: NOW.toISOString(), lastOutcome: 'done (report_stale)' });
    expect(run.posts).toEqual([]);
  });

  it('refresh: exit 1 asks for a retry in 10 minutes', async () => {
    const w = await world();
    const run = levelsContext(testDb(), w.root, NOW);
    const h = harness(testDb());
    const broken = report({ outcome: 'error', ingest: null, error: { code: 'missing_rpc_url', message: 'UNSET_RPC_URL is not set' } });
    const out = await makeRefreshHandler({ fetchDeps: () => h.deps, tick: fakeTick({ report: broken, exitCode: 1 }) })(refreshJob(), run.ctx);
    expect(out).toEqual({
      status: 'failed', result: { report: broken, fetchLines: [], alertFlags: [], levels: 0, alerted: false },
      error: 'missing_rpc_url: UNSET_RPC_URL is not set', retryAfterMs: REFRESH_RETRY_MS,
    });
    expect(REFRESH_RETRY_MS).toBe(600_000);
    expect(run.posts).toEqual([]);
    expect((await getRegistryRow(testDb(), 'mini'))!.lastOutcome).toBe('failed: missing_rpc_url');

    // The lock held by another run: retried in 30 minutes.
    const locked = report({ outcome: 'run_in_progress', ingest: null, lock: { holder: 'tick pid 7', acquired_at: '2026-09-19T00:40:00.000Z' } });
    const out2 = await makeRefreshHandler({ fetchDeps: () => h.deps, tick: fakeTick({ report: locked, exitCode: 0 }) })(refreshJob(), run.ctx);
    expect(out2).toMatchObject({ status: 'failed', error: 'run_in_progress: locked by tick pid 7 since 2026-09-19T00:40:00.000Z', retryAfterMs: REFRESH_LOCKED_RETRY_MS });
    expect(REFRESH_LOCKED_RETRY_MS).toBe(1_800_000);
  });

  it('refresh: the second failure posts ORION ALERT at once', async () => {
    const w = await world();
    const run = levelsContext(testDb(), w.root, NOW);
    const h = harness(testDb());
    const broken = report({ outcome: 'error', ingest: null, error: { code: 'missing_rpc_url', message: 'UNSET_RPC_URL is not set' } });
    const handler = makeRefreshHandler({ fetchDeps: () => h.deps, tick: fakeTick({ report: broken, exitCode: 1 }) });
    await handler(refreshJob(1), run.ctx);
    expect(run.posts).toEqual([]);
    const out = await handler(refreshJob(2), run.ctx);
    expect(out).toMatchObject({ status: 'failed', result: { alerted: true } });
    expect(run.posts).toEqual(['ORION ALERT dev refresh MINI failed twice: missing_rpc_url: UNSET_RPC_URL is not set']);

    // A tick that throws (a bug) is a failure like any other: retried, then alerted.
    const bug = makeRefreshHandler({ fetchDeps: () => h.deps, tick: async () => { throw new TypeError('x is undefined'); } });
    expect(await bug(refreshJob(1), run.ctx)).toMatchObject({ status: 'failed', error: 'TypeError: x is undefined', retryAfterMs: REFRESH_RETRY_MS });
    await bug(refreshJob(2), run.ctx);
    expect(run.posts.at(-1)).toBe('ORION ALERT dev refresh MINI failed twice: TypeError: x is undefined');
  });

  it('refresh: level rows written by the nightly refresh land in latest_levels too', async () => {
    const yaml = INGEST_ASSET_YAML.replace(
      METRICS_END,
      '  stats_price:\n    type: level\n    unit: usd\n    staleness_days: 3\n    monitor_only: true\n    watch: { outside: [1, 2] }\n    source: { type: http_json, url: "https://api.example.test/stats", path: price }\n' + METRICS_END,
    );
    const w = levelsWorld({ mini: yaml });
    worlds.push(w);
    await activate(testDb(), ['mini']);
    const run = levelsContext(testDb(), w.root, NOW);
    const h = harness(testDb());
    const out = await makeRefreshHandler({ fetchDeps: () => h.deps })(refreshJob(), run.ctx);
    expect(out.status).toBe('done');
    const result = (out as { result: { report: TickReport; fetchLines: string[]; levels: number } }).result;
    expect(result.report.ingest?.fetch_run_id).not.toBeNull(); // a real (not dry) fetch ran
    expect(result.fetchLines[0]).toMatch(/^MINI fetch /);
    const rows = await listLatestLevels(testDb(), 'mini');
    expect(rows.map((r) => r.metricKey)).toEqual(['circulating_supply', 'emission_rate_annual', 'price_usd', 'staked_supply', 'stats_price', 'total_supply']);
    expect(rows.every((r) => r.jobId === 1)).toBe(true);
    expect(result.levels).toBe(6);
    // The level watch's state is kept (no post: the nightly report shows it).
    expect(await listWatchStates(testDb(), 'mini')).toEqual([
      { assetId: 'mini', metricKey: 'stats_price', rule: 'outside', firing: true, since: NOW.toISOString(), lastValue: 10.1 },
    ]);
    expect(run.posts).toEqual([]);
  });

  it('refresh: a nightly that clears a firing level watch posts the cleared line', async () => {
    // stats_price reads 10.1; the watch range [1, 20] holds it, so a watch the hourly job left firing clears.
    const yaml = INGEST_ASSET_YAML.replace(
      METRICS_END,
      '  stats_price:\n    type: level\n    unit: usd\n    staleness_days: 3\n    monitor_only: true\n    watch: { outside: [1, 20] }\n    source: { type: http_json, url: "https://api.example.test/stats", path: price }\n' + METRICS_END,
    );
    const w = levelsWorld({ mini: yaml });
    worlds.push(w);
    await activate(testDb(), ['mini']);
    await putWatchStates(testDb(), [{ assetId: 'mini', metricKey: 'stats_price', rule: 'outside', firing: true, since: '2026-09-18T12:15:00.000Z', lastValue: 25 }]);
    const run = levelsContext(testDb(), w.root, NOW);
    const h = harness(testDb());
    const out = await makeRefreshHandler({ fetchDeps: () => h.deps })(refreshJob(), run.ctx);
    expect(out).toMatchObject({ status: 'done', result: { cleared: ['ORION WATCH MINI cleared: stats_price outside'], undelivered: [] } });
    expect(run.posts).toEqual(['ORION WATCH MINI cleared: stats_price outside']);
    expect(await listWatchStates(testDb(), 'mini')).toMatchObject([{ metricKey: 'stats_price', firing: false }]);

    // Undelivered: kept in the result, the job is still done (the refresh is not retried for Slack).
    await putWatchStates(testDb(), [{ assetId: 'mini', metricKey: 'stats_price', rule: 'outside', firing: true, since: '2026-09-18T12:15:00.000Z', lastValue: 25 }]);
    const down = levelsContext(testDb(), w.root, NOW, {}, false);
    const out2 = await makeRefreshHandler({ fetchDeps: () => h.deps })(refreshJob(1, 2), down.ctx);
    expect(out2).toMatchObject({ status: 'done', result: { undelivered: ['ORION WATCH MINI cleared: stats_price outside'] } });
  });

  it('refresh: the daemon runs the refresh handler', () => {
    expect(defaultHandlers().refresh).toBe(refreshHandler);
  });
});
