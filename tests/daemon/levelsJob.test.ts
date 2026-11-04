import { describe, expect, it } from 'vitest';
import { defaultHandlers } from '../../src/daemon/daemon.js';
import { levelsHandler } from '../../src/daemon/jobs/levels.js';
import { listLatestLevels } from '../../src/db/latestLevels.js';
import { setRegistryState } from '../../src/db/registry.js';
import { INGEST_ASSET_YAML } from '../helpers/ingestAsset.js';
import { harness } from '../helpers/fetchHarness.js';
import { useTestDb } from '../helpers/db.js';
import { activate, cleanupAfterAll, handlerFor, levelsContext, levelsJob, levelsWorld } from '../helpers/levelsWorld.js';

const testDb = useTestDb();
const worlds: { cleanup(): void }[] = [];
cleanupAfterAll(worlds);

const SLOT = '2026-09-19T12:15:00.000Z';
const DEADMAN = 'https://hc.example/ping/levels';
const asId = (id: string, yaml = INGEST_ASSET_YAML) => yaml.replace('id: mini\n', `id: ${id}\n`);
/** Chain 1 has no keyless RPC default: with its variable unset the whole fetch throws (missing_rpc_url). */
const unreachable = (id: string) => asId(id).replace('chain_id: 8453, rpc_url_env: TEST_RPC_URL', 'chain_id: 1, rpc_url_env: UNSET_RPC_URL');

async function world(yamls: Record<string, string>, active: string[]) {
  const w = levelsWorld(yamls);
  worlds.push(w);
  await activate(testDb(), active);
  return w;
}

describe('levels job', () => {
  it('levelsJob: the dead-man is pinged after a run and not when every asset failed', async () => {
    const w = await world({ mini: INGEST_ASSET_YAML, other: asId('other') }, ['mini', 'other']);
    const h = harness(testDb());
    const run = levelsContext(testDb(), w.root, SLOT, { ORION_DEADMAN_URL: DEADMAN });
    const out = await handlerFor(run, h.deps)(levelsJob(1, SLOT), run.ctx);
    expect(out).toEqual({ status: 'done', result: { assets: 2, rows: 10, failed: [], fired: [], cleared: [], undelivered: [], deadman: true } });
    expect(run.pings).toEqual([DEADMAN]);
    expect((await listLatestLevels(testDb())).every((r) => r.jobId === 1)).toBe(true);

    const bad = await world({ a: unreachable('a'), b: unreachable('b') }, ['a', 'b']);
    await testDb().run("DELETE FROM asset_registry WHERE asset_id IN ('mini', 'other')");
    const run2 = levelsContext(testDb(), bad.root, SLOT, { ORION_DEADMAN_URL: DEADMAN });
    const failed = await handlerFor(run2, h.deps)(levelsJob(2, SLOT), run2.ctx);
    expect(failed).toMatchObject({ status: 'failed', error: 'every asset failed (2)' });
    expect(run2.pings).toEqual([]);
  });

  it('levelsJob: per-source failures still ping; one asset that throws withholds the ping but the job is done', async () => {
    const w = await world({ mini: INGEST_ASSET_YAML, b: unreachable('b') }, ['mini', 'b']);
    const h = harness(testDb(), { routes: { 'https://api.example.test/stats': new Error('stats down') } });
    const run = levelsContext(testDb(), w.root, SLOT, { ORION_DEADMAN_URL: DEADMAN });
    const out = await handlerFor(run, h.deps)(levelsJob(1, SLOT), run.ctx);
    expect(out.status).toBe('done');
    expect((out as { result: { failed: { assetId: string; sourceId: string }[] } }).result.failed.map((f) => `${f.assetId} ${f.sourceId}`)).toEqual([
      'b *', 'mini http_json:https://api.example.test/stats',
    ]);
    expect(run.pings).toEqual([]);

    await testDb().run("DELETE FROM asset_registry WHERE asset_id = 'b'");
    const again = levelsContext(testDb(), w.root, SLOT, { ORION_DEADMAN_URL: DEADMAN });
    expect((await handlerFor(again, h.deps)(levelsJob(2, SLOT), again.ctx)).status).toBe('done');
    expect(again.pings).toEqual([DEADMAN]); // a cross-check source failed, but every asset's read ran
  });

  it('levelsJob: only active assets are read', async () => {
    const w = await world({ mini: INGEST_ASSET_YAML, other: asId('other') }, ['mini', 'other']);
    await setRegistryState(testDb(), 'other', 'active', 'paused', { at: '2026-09-10T00:00:00.000Z', by: 't', reason: 'x', releaseTag: null });
    const h = harness(testDb());
    const run = levelsContext(testDb(), w.root, SLOT);
    const out = await handlerFor(run, h.deps)(levelsJob(1, SLOT), run.ctx);
    expect(out).toMatchObject({ status: 'done', result: { assets: 1, deadman: false } });
    expect(new Set((await listLatestLevels(testDb())).map((r) => r.assetId))).toEqual(new Set(['mini']));
  });

  it('levelsJob: an undelivered watch post is kept and the dead-man is withheld', async () => {
    const yaml = INGEST_ASSET_YAML.replace(
      'holder_flows:',
      '  stats_price:\n    type: level\n    unit: usd\n    staleness_days: 3\n    monitor_only: true\n    watch: { outside: [1, 2] }\n    source: { type: http_json, url: "https://api.example.test/stats", path: price }\nholder_flows:',
    );
    const w = await world({ mini: yaml }, ['mini']);
    const h = harness(testDb());
    const run = levelsContext(testDb(), w.root, SLOT, { ORION_DEADMAN_URL: DEADMAN }, false);
    const out = await handlerFor(run, h.deps)(levelsJob(1, SLOT), run.ctx);
    expect(out).toMatchObject({ status: 'done', result: { undelivered: ['ORION WATCH MINI: stats_price outside 10.1'], deadman: false } });
    expect(run.pings).toEqual([]);
  });

  it('levelsJob: the onLevels hook runs after the read and a snapshot_push is enqueued for the slot', async () => {
    const w = await world({ mini: INGEST_ASSET_YAML }, ['mini']);
    const h = harness(testDb());
    const run = levelsContext(testDb(), w.root, SLOT);
    const seen: number[] = [];
    const out = await handlerFor(run, h.deps, { onLevels: async (_ctx, _job, r) => void seen.push(r.rows.length) })(levelsJob(1, SLOT), run.ctx);
    expect(out.status).toBe('done');
    expect(seen).toEqual([5]);
    expect(run.enqueued).toEqual([{ kind: 'snapshot_push', assetId: null, slot: SLOT }]);

    const none = levelsContext(testDb(), w.root, SLOT);
    await handlerFor(none, h.deps)(levelsJob(2, SLOT), none.ctx);
    expect(none.enqueued).toEqual([]);
  });

  it('levelsJob: an aborted job stops before its posts and its ping', async () => {
    const w = await world({ mini: INGEST_ASSET_YAML }, ['mini']);
    const h = harness(testDb());
    const run = levelsContext(testDb(), w.root, SLOT, { ORION_DEADMAN_URL: DEADMAN });
    const abort = new AbortController();
    abort.abort();
    const out = await handlerFor(run, h.deps)(levelsJob(1, SLOT), { ...run.ctx, signal: abort.signal });
    expect(out).toMatchObject({ status: 'failed', error: 'aborted: the lease was lost' });
    expect(run.pings).toEqual([]);
    expect(await listLatestLevels(testDb())).toEqual([]);
  });

  it('levelsJob: the daemon runs the levels handler', () => {
    expect(defaultHandlers().levels).toBe(levelsHandler);
  });
});
