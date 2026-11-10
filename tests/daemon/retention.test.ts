import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { JobContext } from '../../src/daemon/daemon.js';
import { RETENTION_JOB_DAYS, retentionHandler } from '../../src/daemon/jobs/retention.js';
import { claimNextJob, enqueueJob, finishJob, listJobs, type Job } from '../../src/db/jobs.js';
import { insertRegistryRow, setRegistryState } from '../../src/db/registry.js';
import { insertSnapshot, pruneSnapshots } from '../../src/db/snapshotsOut.js';
import { buildEnvelope } from '../../src/push/envelope.js';
import { MINI_ASSET_YAML } from '../helpers/assets.js';
import { FakeClock } from '../helpers/clock.js';
import { useTestDb } from '../helpers/db.js';

const db = useTestDb();
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const NOW = '2026-11-03T03:30:00.000Z';

function ctx(): JobContext {
  const root = mkdtempSync(join(tmpdir(), 'orion-retention-'));
  dirs.push(root);
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'assets', 'mini.yaml'), MINI_ASSET_YAML);
  writeFileSync(join(root, 'assets', 'other.yaml'), MINI_ASSET_YAML.replace(/^id: mini$/m, 'id: other'));
  return {
    db: db(), clock: new FakeClock(NOW), env: 'dev', paths: { home: root, configRoot: root, envFile: join(root, 'no.env'), release: null },
    envVars: {}, notify: { post: async () => ({ ok: true, attempts: 1 }) }, signal: new AbortController().signal,
    enqueue: async (j) => await enqueueJob(db(), j), log: () => undefined,
  };
}

/** A job that ran and ended at `ended`. */
async function ended(slot: string, endedAt: string): Promise<void> {
  await enqueueJob(db(), { kind: 'levels', assetId: null, slot });
  const j = await claimNextJob(db(), 'w', new Date(slot), null);
  await finishJob(db(), j!.id, 'w', { status: 'done', result: null }, new Date(endedAt));
}

const self = { id: 99, kind: 'retention' } as Job;

describe('retention', () => {
  it('retention: jobs older than 90 days are deleted, newer kept', async () => {
    expect(RETENTION_JOB_DAYS).toBe(90);
    await ended('2026-07-01T00:15:00.000Z', '2026-07-01T00:16:00.000Z'); // ended 125 days ago: deleted
    await ended('2026-08-04T03:00:00.000Z', '2026-08-05T03:29:00.000Z'); // ended 90 days + 1 min ago: deleted
    await ended('2026-08-04T03:15:00.000Z', '2026-08-05T03:31:00.000Z'); // ended 1 min under 90 days ago: kept
    await ended('2026-11-02T00:15:00.000Z', '2026-11-02T00:16:00.000Z'); // yesterday: kept
    await enqueueJob(db(), { kind: 'refresh', assetId: 'mini', slot: '2026-07-01T00:45:00.000Z' }); // old but queued: kept
    const out = await retentionHandler(self, ctx());
    expect(out).toEqual({ status: 'done', result: { jobs: 2, latestLevels: 0, watchState: 0, snapshots: 0 } });
    expect((await listJobs(db(), {})).map((j) => j.slot).sort()).toEqual([
      '2026-07-01T00:45:00.000Z', '2026-08-04T03:15:00.000Z', '2026-11-02T00:15:00.000Z',
    ]);
  });

  it('retention: levels and watch rows of a missing asset or a metric gone from the YAML are deleted', async () => {
    const c = { at: '2026-10-01T00:00:00.000Z', by: 't', reason: null, releaseTag: null };
    await insertRegistryRow(db(), 'mini', 'active', 'h', c);
    await insertRegistryRow(db(), 'gone', 'active', 'h', c);
    await setRegistryState(db(), 'gone', 'active', 'missing', c);
    const level = (a: string, m: string): Promise<unknown> =>
      db().run("INSERT INTO latest_levels (asset_id, metric_key, value, observed_at, source, source_type, locator) VALUES ($1, $2, 1, $3, 'x', 'market_data', '{}')", [a, m, NOW]);
    const watch = (a: string, m: string): Promise<unknown> =>
      db().run("INSERT INTO watch_state (asset_id, metric_key, rule, firing, since) VALUES ($1, $2, 'above 1', true, $3)", [a, m, NOW]);
    await level('mini', 'price_usd');
    await level('mini', 'old_metric');
    await level('gone', 'price_usd');
    await level('other', 'price_usd'); // a YAML, no registry row yet: kept
    await level('noyaml', 'price_usd'); // neither: deleted
    await watch('mini', 'total_supply');
    await watch('mini', 'old_metric');
    await watch('gone', 'total_supply');
    const out = await retentionHandler(self, ctx());
    expect(out).toEqual({ status: 'done', result: { jobs: 0, latestLevels: 3, watchState: 2, snapshots: 0 } });
    expect(await db().all('SELECT asset_id, metric_key FROM latest_levels ORDER BY asset_id, metric_key')).toEqual([
      { asset_id: 'mini', metric_key: 'price_usd' }, { asset_id: 'other', metric_key: 'price_usd' },
    ]);
    expect(await db().all('SELECT asset_id, metric_key FROM watch_state')).toEqual([{ asset_id: 'mini', metric_key: 'total_supply' }]);
  });
  it('retention: snapshots older than 30 days are pruned but the newest 7 full stay', async () => {
    const day = (n: number): Date => new Date(Date.parse(NOW) - n * 86_400_000);
    const put = async (kind: 'full' | 'levels', ageDays: number): Promise<void> => {
      const d = day(ageDays);
      await insertSnapshot(db(), { kind, day: kind === 'full' ? d.toISOString().slice(0, 10) : null, envelope: buildEnvelope(kind, { ageDays }, { seq: 0, env: 'dev', releaseTag: null, now: d }) });
    };
    // Fulls aged 60..40 days (10 rows, all past 30 days): the newest 7 stay. Levels: 45, 35 and 31 days (pruned), 5 days (kept).
    for (let age = 60; age >= 42; age -= 2) await put('full', age);
    await put('levels', 45);
    await put('levels', 35);
    await put('levels', 31);
    await put('levels', 5);
    const out = await retentionHandler(self, ctx());
    expect(out).toEqual({ status: 'done', result: { jobs: 0, latestLevels: 0, watchState: 0, snapshots: 6 } });
    const left = await db().all<{ kind: string; body: string }>('SELECT kind, body FROM snapshots_out ORDER BY kind, seq');
    expect(left.map((r) => `${r.kind} ${(JSON.parse(r.body) as { body: { ageDays: number } }).body.ageDays}`)).toEqual([
      'full 54', 'full 52', 'full 50', 'full 48', 'full 46', 'full 44', 'full 42', 'levels 5',
    ]);
    expect(await pruneSnapshots(db(), new Date(NOW))).toBe(0);
  });

  it('retention: the newest levels snapshot is kept however old, so the published file set stays whole', async () => {
    await insertSnapshot(db(), { kind: 'levels', day: null, envelope: buildEnvelope('levels', {}, { seq: 0, env: 'dev', releaseTag: null, now: new Date('2026-08-01T00:00:00.000Z') }) });
    await insertSnapshot(db(), { kind: 'levels', day: null, envelope: buildEnvelope('levels', {}, { seq: 0, env: 'dev', releaseTag: null, now: new Date('2026-08-02T00:00:00.000Z') }) });
    expect(await pruneSnapshots(db(), new Date(NOW))).toBe(1);
    expect(await db().all('SELECT kind, seq FROM snapshots_out')).toEqual([{ kind: 'levels', seq: 2 }]);
  });
});
