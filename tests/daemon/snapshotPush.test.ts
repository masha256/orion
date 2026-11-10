import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { defaultHandlers } from '../../src/daemon/daemon.js';
import { levelsSnapshot, makeSnapshotPushHandler, PUSH_BACKOFF_MIN, recordSnapshot, snapshotPushHandler } from '../../src/daemon/jobs/snapshotPush.js';
import { upsertLatestLevels } from '../../src/db/latestLevels.js';
import { insertRegistryRow, listRegistry, setRegistryState } from '../../src/db/registry.js';
import { insertSnapshot, pendingSnapshots } from '../../src/db/snapshotsOut.js';
import { assetsFile, fullBody, levelsBody } from '../../src/push/body.js';
import { buildEnvelope, type SnapshotEnvelope } from '../../src/push/envelope.js';
import { OrionError } from '../../src/types.js';
import { MINI_ASSET_YAML, MINI_REPORT_YAML, seedMiniReport } from '../helpers/assets.js';
import { useTestDb } from '../helpers/db.js';
import { pushContext, pushJob } from '../helpers/pushWorld.js';

const db = useTestDb();
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function home(): { root: string; envVars: Record<string, string> } {
  const root = mkdtempSync(join(tmpdir(), 'orion-push-'));
  dirs.push(root);
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'assets', 'mini.yaml'), MINI_ASSET_YAML);
  const key = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  writeFileSync(join(root, 'sign.key'), key);
  return { root, envVars: { ORION_PUBLISH: 'git:file:///nowhere.git#main', ORION_SIGN_KEY_FILE: join(root, 'sign.key') } };
}

const change = (at: string) => ({ at, by: 'test', reason: null, releaseTag: null });
const env = { env: 'stage' as const, seq: 0, releaseTag: 'orion-2026.11.03.1' };
const T0 = Date.parse('2026-11-03T01:15:00.000Z');
const at = (min: number): string => new Date(T0 + min * 60_000).toISOString();

async function levelsRow(min: number, body: unknown = { assets: {} }) {
  return await insertSnapshot(db(), { kind: 'levels', day: null, envelope: buildEnvelope('levels', body, { ...env, now: new Date(at(min)) }) });
}

describe('snapshotPush', () => {
  it('snapshotPush: a failed push is retried after 1, 5, 15 minutes then hourly and alerts once after 3 h', async () => {
    expect(PUSH_BACKOFF_MIN).toEqual([1, 5, 15]);
    const h = home();
    await levelsRow(0);
    const published: string[] = [];
    const handler = makeSnapshotPushHandler({
      publisher: () => ({ publish: async (_files, message) => { published.push(message); throw new OrionError('publish_git_failed', 'git push failed (128): ssh: connect to host github.com port 22: Network is unreachable'); } }),
    });
    const retries: string[] = [];
    const alerts: string[] = [];
    let now = 1;
    for (let i = 0; i < 8; i++) {
      const run = pushContext(db(), h.root, at(now), h.envVars);
      const out = await handler(pushJob(i + 1), run.ctx);
      expect(out).toMatchObject({ status: 'failed', error: expect.stringContaining('Network is unreachable') });
      expect(run.enqueued).toHaveLength(1);
      expect(run.enqueued[0]).toMatchObject({ kind: 'snapshot_push', assetId: null, requestedBy: 'snapshot_push retry' });
      const next = run.enqueued[0].slot;
      retries.push(`${(Date.parse(next) - Date.parse(at(now))) / 60_000}`);
      alerts.push(...run.posts.map((p) => `${now}: ${p}`));
      now = (Date.parse(next) - T0) / 60_000;
    }
    // Attempts 1, 2, 3 -> 1, 5, 15 min; from the 4th on, hourly.
    expect(retries).toEqual(['1', '5', '15', '60', '60', '60', '60', '60']);
    expect(published).toHaveLength(8);
    // Runs at 1, 2, 7, 22, 82, 142, 202, 262 min: the first one past 3 h (202) alerts, once.
    expect(alerts).toEqual([
      '202: ORION ALERT stage snapshot publish failing since 2026-11-03T01:15:00.000Z: git push failed (128): ssh: connect to host github.com port 22: Network is unreachable',
    ]);
    const [row] = await pendingSnapshots(db());
    expect(row).toMatchObject({ attempts: 8, alertedAt: at(202), pushedAt: null, lastError: expect.stringContaining('Network is unreachable') });
  });

  it('snapshotPush: a success publishes the newest of each kind once and marks every pending row it covered', async () => {
    const h = home();
    await insertRegistryRow(db(), 'mini', 'active', 'h', change('2026-09-01T00:00:00.000Z'));
    await levelsRow(0, { assets: { n: 1 } });
    await insertSnapshot(db(), { kind: 'full', day: '2026-11-02', envelope: buildEnvelope('full', { day: '2026-11-02', assets: {} }, { ...env, now: new Date(at(1)) }) });
    await levelsRow(2, { assets: { n: 3 } });
    const calls: { files: Record<string, string>; message: string }[] = [];
    const handler = makeSnapshotPushHandler({ publisher: () => ({ publish: async (files, message) => (calls.push({ files, message }), { ref: 'abc123' }) }) });
    const run = pushContext(db(), h.root, at(3), h.envVars);
    expect(await handler(pushJob(1), run.ctx)).toEqual({ status: 'done', result: { pushed: 3, ref: 'abc123', full: 1, levels: 2 } });
    expect(calls).toHaveLength(1);
    expect(calls[0].message).toBe('full seq 1 day 2026-11-02 release orion-2026.11.03.1');
    expect((JSON.parse(calls[0].files['levels/latest.json']) as SnapshotEnvelope).body).toEqual({ assets: { n: 3 } });
    expect(JSON.parse(calls[0].files['assets.json'])).toEqual({ mini: { state: 'active', since: '2026-09-01T00:00:00.000Z', reason: null } });
    expect(await pendingSnapshots(db())).toEqual([]);

    // Later only a levels row is new: the full files come from the newest pushed full.
    await levelsRow(60, { assets: { n: 4 } });
    const later = pushContext(db(), h.root, at(61), h.envVars);
    expect(await handler(pushJob(2), later.ctx)).toMatchObject({ status: 'done', result: { pushed: 1, full: 1, levels: 3 } });
    expect(calls[1].message).toBe('levels seq 3 day - release orion-2026.11.03.1');
    expect(calls[1].files['full/2026/2026-11-02.json']).toBe(calls[0].files['full/2026/2026-11-02.json']);

    // Nothing pending: nothing to publish.
    const idle = pushContext(db(), h.root, at(62), h.envVars);
    expect(await handler(pushJob(3), idle.ctx)).toEqual({ status: 'done', result: { pushed: 0 } });
    expect(calls).toHaveLength(2);
  });

  it('snapshotPush: ORION_PUBLISH unset skips and leaves rows pending', async () => {
    const h = home();
    await levelsRow(0);
    let made = 0;
    const handler = makeSnapshotPushHandler({ publisher: () => (made++, null) });
    const run = pushContext(db(), h.root, at(1), {});
    expect(await handler(pushJob(1), run.ctx)).toEqual({ status: 'skipped', result: { reason: 'publishing off (ORION_PUBLISH unset)', pending: 1 } });
    expect(made).toBe(0);
    expect(run.posts).toEqual([]);
    expect(run.enqueued).toEqual([]);
    expect((await pendingSnapshots(db())).map((r) => [r.seq, r.attempts])).toEqual([[1, 0]]);
  });

  it('snapshotPush: a missing signing key or an s3 target fails like a push and is retried', async () => {
    const h = home();
    await levelsRow(0);
    const noKey = pushContext(db(), h.root, at(1), { ORION_PUBLISH: h.envVars.ORION_PUBLISH });
    expect(await snapshotPushHandler(pushJob(1), noKey.ctx)).toMatchObject({ status: 'failed', error: expect.stringContaining('ORION_SIGN_KEY_FILE') });
    const s3 = pushContext(db(), h.root, at(2), { ...h.envVars, ORION_PUBLISH: 's3:https://x/b' });
    expect(await snapshotPushHandler(pushJob(2), s3.ctx)).toMatchObject({ status: 'failed', error: expect.stringContaining('s3') });
    const prod = pushContext(db(), h.root, at(7), { ...h.envVars, ORION_PUBLISH: 'git:git@github.com:masha256/orion-data.git#main' });
    expect(await snapshotPushHandler(pushJob(3), prod.ctx)).toMatchObject({ status: 'failed', error: expect.stringContaining('prod snapshot repo') });
    expect(prod.posts).toHaveLength(1); // a wrong repo is alerted at once, like a moved remote
    expect((await pendingSnapshots(db())).map((r) => r.attempts)).toEqual([3]);
  });

  it('snapshotPush: an aborted job writes nothing', async () => {
    const h = home();
    await levelsRow(0);
    const run = pushContext(db(), h.root, at(1), h.envVars);
    const abort = new AbortController();
    run.ctx.signal = abort.signal;
    const handler = makeSnapshotPushHandler({ publisher: () => ({ publish: async () => { abort.abort(); throw new Error('push failed'); } }) });
    expect(await handler(pushJob(1), run.ctx)).toMatchObject({ status: 'failed', error: expect.stringContaining('aborted') });
    expect((await pendingSnapshots(db())).map((r) => r.attempts)).toEqual([0]);
    expect(run.enqueued).toEqual([]);
  });

  it('snapshotPush: the daemon runs it', () => {
    expect(defaultHandlers().snapshot_push).toBe(snapshotPushHandler);
  });
});

describe('snapshot bodies', () => {
  it('snapshot bodies: levels for active and paused assets; assets.json with state, since and reason', async () => {
    await insertRegistryRow(db(), 'mini', 'active', 'h', change('2026-09-01T00:00:00.000Z'));
    await insertRegistryRow(db(), 'paws', 'active', 'h', change('2026-09-01T00:00:00.000Z'));
    await setRegistryState(db(), 'paws', 'active', 'paused', { ...change('2026-10-20T00:00:00.000Z'), reason: 'source broken' });
    await insertRegistryRow(db(), 'idle', 'inactive', 'h', change('2026-09-01T00:00:00.000Z'));
    const level = { metricKey: 'price_usd', value: 1.5, observedAt: '2026-11-03T01:00:00.000Z', source: 'coingecko', blockNumber: null, jobId: 3, sourceType: 'market_data', locator: { provider: 'coingecko' } };
    await upsertLatestLevels(db(), [{ assetId: 'mini', ...level }, { assetId: 'idle', ...level }]);
    const registry = await listRegistry(db());
    expect(await levelsBody(db(), registry)).toEqual({
      assets: { mini: { state: 'active', levels: [{ assetId: 'mini', ...level }] }, paws: { state: 'paused', levels: [] } },
    });
    expect(assetsFile(registry)).toEqual({
      mini: { state: 'active', since: '2026-09-01T00:00:00.000Z', reason: null },
      paws: { state: 'paused', since: '2026-10-20T00:00:00.000Z', reason: 'source broken' },
    });
  });

  it('snapshot bodies: the full body carries each asset report or why there is none', async () => {
    const h = home();
    writeFileSync(join(h.root, 'assets', 'paws.yaml'), MINI_ASSET_YAML.replace(/^id: mini$/m, 'id: paws'));
    await insertRegistryRow(db(), 'mini', 'active', 'h', change('2026-09-01T00:00:00.000Z'));
    await insertRegistryRow(db(), 'paws', 'active', 'h', change('2026-09-01T00:00:00.000Z'));
    await setRegistryState(db(), 'paws', 'active', 'paused', { ...change('2026-10-20T00:00:00.000Z'), reason: 'r' });
    await insertRegistryRow(db(), 'gone', 'active', 'h', change('2026-09-01T00:00:00.000Z'));
    const body = await fullBody(db(), h.root, await listRegistry(db()), '2026-11-02');
    expect(body).toEqual({
      day: '2026-11-02',
      assets: {
        gone: { state: 'active', state_since: '2026-09-01T00:00:00.000Z', state_reason: null, report_day: null, lag_days: null, report: null, report_error: expect.stringContaining('gone') },
        mini: { state: 'active', state_since: '2026-09-01T00:00:00.000Z', state_reason: null, report_day: null, lag_days: null, report: null, report_error: 'no income_statement block' },
        paws: { state: 'paused', state_since: '2026-10-20T00:00:00.000Z', state_reason: 'r', report_day: null, lag_days: null, report: null, report_error: 'no income_statement block' },
      },
    });
  });

  it('full snapshot body carries the v2 report only (orion.snapshot/2, Task 11b)', async () => {
    const h = home();
    writeFileSync(join(h.root, 'assets', 'mini.yaml'), MINI_REPORT_YAML);
    await insertRegistryRow(db(), 'mini', 'active', 'h', change('2026-09-01T00:00:00.000Z'));
    await seedMiniReport(db(), '2026-11-02');
    const body = (await fullBody(db(), h.root, await listRegistry(db()), '2026-11-02')) as { assets: Record<string, { report: Record<string, unknown>; report_day: string; report_error: string | null }> };
    const mini = body.assets.mini!;
    expect(mini).toMatchObject({ report_day: '2026-11-02', report_error: null });
    // The `report yield --json` object: no v1 key (the reason for orion.snapshot/2).
    expect(Object.keys(mini.report)).toEqual(['asset', 'day', 'windowDays', 'price', 'marketCap', 'fdv', 'incomeStatement', 'notes']);
    expect(mini.report.incomeStatement).toMatchObject({ schema: 2, day: '2026-11-02', revenue: { annualized: expect.any(Number) } });
  });

  it('snapshot bodies: the levels hook writes a levels snapshot and recordSnapshot a full one', async () => {
    const h = home();
    await insertRegistryRow(db(), 'mini', 'active', 'h', change('2026-09-01T00:00:00.000Z'));
    const run = pushContext(db(), h.root, at(0), h.envVars);
    await levelsSnapshot(run.ctx);
    const full = await recordSnapshot(run.ctx, 'full', { day: '2026-11-02', assets: {} }, '2026-11-02');
    const rows = await pendingSnapshots(db());
    expect(rows.map((r) => [r.kind, r.seq, r.day])).toEqual([['levels', 1, null], ['full', 1, '2026-11-02']]);
    expect(full.id).toBe(rows[1].id);
    expect(JSON.parse(rows[0].body)).toMatchObject({
      schema: 'orion.snapshot/2', kind: 'levels', seq: 1, env: 'stage', release_tag: 'orion-2026.11.03.1', generated_at: at(0),
      body: { assets: { mini: { state: 'active', levels: [] } } },
    });
  });
});
