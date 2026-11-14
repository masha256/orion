import { describe, expect, it } from 'vitest';
import { defaultHandlers } from '../../src/daemon/daemon.js';
import { levelsHandler } from '../../src/daemon/jobs/levels.js';
import { listLatestLevels } from '../../src/db/latestLevels.js';
import { setRegistryState } from '../../src/db/registry.js';
import { INGEST_ASSET_YAML, METRICS_END } from '../helpers/ingestAsset.js';
import { harness } from '../helpers/fetchHarness.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listPrices } from '../../src/db/prices.js';
import { loadPrices, methodSource } from '../../src/prices/config.js';
import { fakePriceWriter } from '../helpers/chainPrices.js';
import { useTestDb } from '../helpers/db.js';
import { activate, cleanupAfterAll, handlerFor, levelsContext, levelsJob, levelsWorld } from '../helpers/levelsWorld.js';

const testDb = useTestDb();
const worlds: { cleanup(): void }[] = [];
cleanupAfterAll(worlds);

const SLOT = '2026-09-19T12:15:00.000Z';
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
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
    expect(out).toEqual({ status: 'done', result: { assets: 2, rows: 10, failed: [], fired: [], cleared: [], undelivered: [], deadman: true, prices: null } });
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
      METRICS_END,
      '  stats_price:\n    type: level\n    unit: usd\n    staleness_days: 3\n    monitor_only: true\n    watch: { outside: [1, 2] }\n    source: { type: http_json, url: "https://api.example.test/stats", path: price }\n' + METRICS_END,
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

  it('levelsJob: writes the last completed hour of every prices.yaml ref, and posts each breach the write reports once (ORION WATCH, never an anomaly)', async () => {
    const w = await world({ mini: INGEST_ASSET_YAML }, ['mini']);
    // The repo's prices.yaml, plus the mini token (its usd flows are valued at it: the load-time check wants its entry).
    const mini = `"eip155:8453/0x1111111111111111111111111111111111111111":\n  symbol: MINI\n  decimals: 18\n  chain: eip155:8453\n  valid_from: "2026-09-01"\n` +
      `  primary: { kind: chainlink, feed: "0x${'a'.repeat(40)}" }\n  check: { kind: chainlink, feed: "0x${'b'.repeat(40)}", tolerance_pct: 2 }\n`;
    writeFileSync(join(w.root, 'prices.yaml'), `${readFileSync(join(ROOT, 'prices.yaml'), 'utf8')}\n${mini}`);
    const prices = loadPrices(w.root);
    expect(prices.size).toBe(loadPrices(ROOT).size + 1);
    const crv = [...prices.values()].find((e) => e.symbol === 'CRV')!;
    const lastHour = Date.parse('2026-09-19T11:00:00.000Z');
    const breach = { ref: crv.ref, hourMs: lastHour, gapPct: -1.7, check: 'chain:chainlink' };
    const h = harness(testDb());
    const primary = (ref: string) => methodSource(prices.get(ref)!.primary); // stored as the real writer stores it
    const writer = fakePriceWriter(() => 10, { breaches: [breach] }, primary);
    const run = levelsContext(testDb(), w.root, '2026-09-19T12:15:00.000Z', { ORION_DEADMAN_URL: DEADMAN });
    const out = await handlerFor(run, { ...h.deps, priceWriter: writer })(levelsJob(1, SLOT), run.ctx);
    const post = 'ORION WATCH dev price CRV 2026-09-19T11:00:00.000Z: -1.70% vs chain:chainlink';
    expect(out).toMatchObject({ status: 'done', result: { prices: { written: prices.size * 48, missing: 0, errors: [], breaches: [post] }, deadman: true } });
    expect(run.posts).toEqual([post]);
    for (const ref of prices.keys()) expect((await listPrices(testDb(), ref)).map((p) => p.ts), ref).toContain('2026-09-19T11:00:00.000Z');
    expect(await testDb().all('SELECT id FROM anomalies')).toEqual([]);

    // The next hour: only the new hour is written for every ref; no breach reported, nothing posted.
    const next = levelsContext(testDb(), w.root, '2026-09-19T13:15:00.000Z');
    const quiet = fakePriceWriter(() => 10, {}, primary);
    await handlerFor(next, { ...h.deps, priceWriter: quiet })(levelsJob(2, SLOT), next.ctx);
    expect(quiet.calls.map((c) => [new Date(c.fromHourMs).toISOString(), new Date(c.toHourMs).toISOString()])).toEqual([['2026-09-19T12:00:00.000Z', '2026-09-19T13:00:00.000Z']]);
    expect(next.posts).toEqual([]);
  });

  it('levelsJob: a price write that throws or reports chain errors posts one ORION ALERT <env> levels prices line; reads, snapshot_push and dead-man as before', async () => {
    const w = await world({ mini: INGEST_ASSET_YAML }, ['mini']);
    const mini = `"eip155:8453/0x1111111111111111111111111111111111111111":\n  symbol: MINI\n  decimals: 18\n  chain: eip155:8453\n  valid_from: "2026-09-01"\n` +
      `  primary: { kind: chainlink, feed: "0x${'a'.repeat(40)}" }\n  check: { kind: chainlink, feed: "0x${'b'.repeat(40)}", tolerance_pct: 2 }\n`;
    writeFileSync(join(w.root, 'prices.yaml'), `${readFileSync(join(ROOT, 'prices.yaml'), 'utf8')}\n${mini}`);
    const h = harness(testDb());
    const seen: number[] = [];
    const onLevels = async (_c: unknown, _j: unknown, r: { rows: unknown[] }) => void seen.push(r.rows.length);

    // The writer throws.
    const run = levelsContext(testDb(), w.root, SLOT, { ORION_DEADMAN_URL: DEADMAN });
    const thrower = async () => Promise.reject(new Error('rpc down'));
    const out = await handlerFor(run, { ...h.deps, priceWriter: thrower }, { onLevels })(levelsJob(1, SLOT), run.ctx);
    expect(out).toMatchObject({ status: 'done', result: { rows: 5, failed: [], deadman: true, undelivered: [], prices: { written: 0, errors: ['rpc down'] } } });
    expect(run.posts).toEqual(['ORION ALERT dev levels prices: rpc down']);
    expect(run.pings).toEqual([DEADMAN]);
    expect(seen).toEqual([5]);
    expect(run.enqueued).toEqual([{ kind: 'snapshot_push', assetId: null, slot: SLOT }]);

    // The writer returns chain errors (it stopped two chains): still one line, naming both.
    const run2 = levelsContext(testDb(), w.root, '2026-09-19T13:15:00.000Z', { ORION_DEADMAN_URL: DEADMAN });
    const errs = fakePriceWriter(() => 10, { errors: [{ chain: 'eip155:1', hourMs: Date.parse('2026-09-19T10:00:00.000Z'), error: 'timeout' }, { chain: 'eip155:56', hourMs: Date.parse('2026-09-19T11:00:00.000Z'), error: 'refused' }] });
    const out2 = await handlerFor(run2, { ...h.deps, priceWriter: errs })(levelsJob(2, SLOT), run2.ctx);
    expect(out2).toMatchObject({ status: 'done', result: { deadman: true } });
    expect(run2.posts).toEqual(['ORION ALERT dev levels prices: eip155:1: timeout; eip155:56: refused']);

    // A clean write posts nothing.
    const run3 = levelsContext(testDb(), w.root, '2026-09-19T14:15:00.000Z', { ORION_DEADMAN_URL: DEADMAN });
    await handlerFor(run3, { ...h.deps, priceWriter: fakePriceWriter(() => 10) })(levelsJob(3, SLOT), run3.ctx);
    expect(run3.posts).toEqual([]);
    expect(run3.pings).toEqual([DEADMAN]);

    // An undelivered alert withholds the ping, as any undelivered post does.
    const down = levelsContext(testDb(), w.root, '2026-09-19T15:15:00.000Z', { ORION_DEADMAN_URL: DEADMAN }, false);
    const out4 = await handlerFor(down, { ...h.deps, priceWriter: thrower })(levelsJob(4, SLOT), down.ctx);
    expect(out4).toMatchObject({ status: 'done', result: { undelivered: ['ORION ALERT dev levels prices: rpc down'], deadman: false } });
  });

  it('levelsJob: the daemon runs the levels handler', () => {
    expect(defaultHandlers().levels).toBe(levelsHandler);
  });
});
