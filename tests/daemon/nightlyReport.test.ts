import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { insertObservation } from '../../src/db/observations.js';
import { addDays } from '../../src/ingest/time.js';
import { buildEnvelope } from '../../src/push/envelope.js';
import { insertSnapshot } from '../../src/db/snapshotsOut.js';
import type { TickReport } from '../../src/app/tickReport.js';
import { defaultHandlers, type JobContext } from '../../src/daemon/daemon.js';
import { makeNightlyReportHandler, nightlyReportHandler, NIGHTLY_WAIT_MS, NIGHTLY_DEFER_MS } from '../../src/daemon/jobs/nightlyReport.js';
import { enqueueJob, listJobs, type Job, type JobStatus } from '../../src/db/jobs.js';
import { insertRegistryRow, setRegistryState } from '../../src/db/registry.js';
import { pendingSnapshots } from '../../src/db/snapshotsOut.js';
import { putWatchStates } from '../../src/db/watchState.js';
import { slackNotifier } from '../../src/notify/slack.js';
import { useTestDb } from '../helpers/db.js';
import { FakeClock } from '../helpers/clock.js';
import { INGEST_ASSET_YAML } from '../helpers/ingestAsset.js';
import { cleanupAfterAll, levelsContext, levelsWorld } from '../helpers/levelsWorld.js';

const testDb = useTestDb();
const worlds: { cleanup(): void }[] = [];
cleanupAfterAll(worlds);

const SLOT = '2026-11-03T00:45:00.000Z';
const SLOT_MS = Date.parse(SLOT);
const DEADMAN = 'https://hc.example/ping/nightly';
const RELEASE = { tag: 'orion-2026.11.03.1', commit: 'c', schema: 2, builtAt: 'b' };
const asId = (id: string) => INGEST_ASSET_YAML.replace('id: mini\n', `id: ${id}\n`).replace('symbol: MINI\n', `symbol: ${id.toUpperCase()}\n`);
const at = (ms: number) => new Date(SLOT_MS + ms).toISOString();

function cleanReport(asset = 'mini'): TickReport {
  return {
    schema_version: 2, tick_id: `tick_${asset}`, asset, started_at: at(0), ended_at: at(60_000), outcome: 'completed', lock: null,
    ingest: { fetch_run_id: 1, outcome: 'ok', sources_failed: [], anomalies_raised: [] },
    holder_yield: {
      day: '2026-11-02', window_days: 30, price: 10, market_cap: 600, fdv: 1000, revenue_annualized: 100, revenue_growth_annualized: 0.1,
      payout_ratio: 0.5, flows: [], yields: { cash: 0.01, buyback: null, shareholder: 0.01, dilution: 0, net_shareholder: 0.01 }, multiple: 10,
      holder_flow_growth_annualized: null,
    },
    report_error: null, inbox: { observations: [], proposals: [], anomalies: [] }, error: null,
  };
}

async function world(ids: string[], active = ids, yamls: Record<string, string> = {}) {
  const w = levelsWorld(Object.fromEntries(ids.map((id) => [id, yamls[id] ?? asId(id)])));
  worlds.push(w);
  for (const id of active) await insertRegistryRow(testDb(), id, 'active', `hash-${id}`, { at: '2026-10-01T00:00:00.000Z', by: 'test', reason: null, releaseTag: null });
  return w;
}

/** A refresh job of the slot in `status`, with the handler's result. */
async function refresh(asset: string, status: JobStatus, result: unknown = { report: cleanReport(asset), fetchLines: [], alertFlags: [], levels: 0 }, slot = SLOT): Promise<Job> {
  const j = (await enqueueJob(testDb(), { kind: 'refresh', assetId: asset, slot }))!;
  await testDb().run('UPDATE jobs SET status = $2, result_json = $3, attempts = 1, ended_at = $4 WHERE id = $1', [
    j.id, status, status === 'queued' || status === 'running' ? null : JSON.stringify(result), status === 'queued' || status === 'running' ? null : at(600_000),
  ]);
  return j;
}

async function reportJob(slot = SLOT): Promise<Job> {
  const j = (await enqueueJob(testDb(), { kind: 'nightly_report', assetId: null, slot }))!;
  return { ...j, status: 'running', attempts: 1 };
}

interface NightlyRun {
  posts: string[];
  pings: string[];
  ctx: JobContext;
  clock: FakeClock;
}

function nightly(root: string, nowMs: number, over: Partial<JobContext> = {}): NightlyRun {
  const base = levelsContext(testDb(), root, at(nowMs), { ORION_DEADMAN_NIGHTLY_URL: DEADMAN });
  const clock = base.ctx.clock as FakeClock;
  return { posts: base.posts, pings: base.pings, clock, ctx: { ...base.ctx, paths: { ...base.ctx.paths, release: RELEASE }, ...over } };
}

function handler(run: NightlyRun) {
  return makeNightlyReportHandler({
    fetch: (async (url: string | URL | Request) => {
      run.pings.push(String(url));
      return new Response('ok', { status: 200 });
    }) as typeof fetch,
  });
}

const firstLines = (posts: string[]) => posts.map((p) => p.split('\n')[0]);

describe('nightly_report job', () => {
  it('nightly_report: waits while a refresh is running, then posts after it ends', async () => {
    const w = await world(['mini']);
    const j = await refresh('mini', 'running');
    const job = await reportJob();
    const run = nightly(w.root, 15 * 60_000);
    const out = await handler(run)(job, run.ctx);
    expect(out).toEqual({ status: 'deferred', untilMs: SLOT_MS + 15 * 60_000 + NIGHTLY_DEFER_MS });
    expect(NIGHTLY_DEFER_MS).toBe(300_000);
    expect(run.posts).toEqual([]);
    expect(run.pings).toEqual([]);

    await testDb().run("UPDATE jobs SET status = 'done', result_json = $2, ended_at = $3 WHERE id = $1", [
      j.id, JSON.stringify({ report: cleanReport(), fetchLines: [], alertFlags: [], levels: 0 }), at(20 * 60_000),
    ]);
    const later = nightly(w.root, 20 * 60_000);
    const done = await handler(later)(job, later.ctx);
    expect(done.status).toBe('done');
    expect(later.posts).toHaveLength(1);
    const lines = later.posts[0]!.split('\n');
    expect(lines[0]).toBe('ORION NIGHTLY dev 2026-11-02: 1 assets ok');
    expect(lines[1]).toBe('release orion-2026.11.03.1');
    expect(lines).toContain('== MINI ==');
    expect(lines).toContain('HOLDER YIELD MINI  2026-11-02 (30d window)');
    expect(lines.at(-1)).toBe('reply to Raymond: confirm <id> | reject <id> | approve <id> [note] | decline <id> <note> | ack <id> <note> | resolve <id> <note>');
    expect(later.pings).toEqual([DEADMAN]);
    expect(done).toMatchObject({ result: { day: '2026-11-02', delivered: true, deadman: true, alerts: 0, refreshesMissing: [] } });
  });

  it('nightly_report: posts after 3 h even if a refresh is stuck, listing it as missing, as an ALERT', async () => {
    const w = await world(['mini', 'other']);
    await refresh('mini', 'done');
    await refresh('other', 'running');
    const job = await reportJob();
    const early = nightly(w.root, NIGHTLY_WAIT_MS - 60_000);
    // One minute before the cut: the defer stops at the cut, not five minutes later.
    expect(await handler(early)(job, early.ctx)).toEqual({ status: 'deferred', untilMs: SLOT_MS + NIGHTLY_WAIT_MS });
    expect(NIGHTLY_WAIT_MS).toBe(3 * 3_600_000);

    const run = nightly(w.root, NIGHTLY_WAIT_MS);
    const out = await handler(run)(job, run.ctx);
    expect(out).toMatchObject({ status: 'done', result: { delivered: true, alerts: 1, refreshesMissing: ['other'] } });
    const lines = run.posts.join('\n').split('\n');
    expect(lines[0]).toBe('ORION ALERT dev nightly 2026-11-02: 1 alert(s)');
    expect(lines).toContain('REFRESH MISSING OTHER: no finished refresh 3 h after the 2026-11-03T00:45:00.000Z slot');
    expect(run.pings).toEqual([DEADMAN]); // delivered: the report itself carries the alert
  });

  it('nightly_report: lists PAUSED with since, by and reason', async () => {
    const w = await world(['mini', 'aero', 'later'], ['mini', 'aero']);
    await setRegistryState(testDb(), 'aero', 'active', 'paused', { at: '2026-11-03T00:10:00.000Z', by: 'mike via raymond', reason: 'AERO+VELO merger rebuild', releaseTag: null });
    await insertRegistryRow(testDb(), 'later', 'inactive', 'h', { at: '2026-10-20T00:00:00.000Z', by: 'reconcile', reason: null, releaseTag: 'orion-2026.10.20.1' });
    await insertRegistryRow(testDb(), 'gone', 'missing', 'h', { at: '2026-10-21T00:00:00.000Z', by: 'reconcile', reason: 'YAML removed', releaseTag: null });
    await refresh('mini', 'done');
    await refresh('aero', 'skipped', { reason: 'paused' });
    const run = nightly(w.root, 30 * 60_000);
    const out = await handler(run)(await reportJob(), run.ctx);
    expect(out.status).toBe('done');
    const lines = run.posts[0]!.split('\n');
    expect(lines[0]).toBe('ORION NIGHTLY dev 2026-11-02: 1 assets ok');
    expect(lines).toContain('PAUSED AERO since 2026-11-03 by mike via raymond: AERO+VELO merger rebuild');
    expect(lines).toContain('INACTIVE LATER since 2026-10-20 by reconcile');
    expect(lines).toContain('MISSING GONE since 2026-10-21 by reconcile: YAML removed');
    expect(lines).not.toContain('== AERO ==');
  });

  it('nightly_report: undeliverable report is kept and the dead-man is not pinged', async () => {
    const w = await world(['mini']);
    await refresh('mini', 'done');
    let webhookCalls = 0;
    const notify = slackNotifier({
      webhookUrl: 'https://hooks.slack.test/services/x',
      fetch: (async () => (webhookCalls++, new Response('down', { status: 500 }))) as typeof fetch,
      sleep: async () => undefined,
      log: () => undefined,
    });
    const run = nightly(w.root, 30 * 60_000, { notify, enqueue: async (j) => await enqueueJob(testDb(), j) });
    const out = await handler(run)(await reportJob(), run.ctx);
    expect(out.status).toBe('done');
    const result = (out as { result: { delivered: boolean; posts: string[]; deadman: boolean } }).result;
    expect(result.delivered).toBe(false);
    expect(result.deadman).toBe(false);
    expect(result.posts).toHaveLength(1);
    expect(result.posts[0]).toMatch(/^ORION NIGHTLY dev 2026-11-02: 1 assets ok\n/);
    expect(webhookCalls).toBe(4);
    expect(run.pings).toEqual([]); // the nightly dead-man fetch count is 0
    expect((await listJobs(testDb(), { kind: 'snapshot_push' })).map((j) => j.slot)).toEqual([SLOT]);
    expect((await pendingSnapshots(testDb())).map((r) => [r.kind, r.day])).toEqual([['full', '2026-11-02']]);
  });

  it('nightly_report: labelled with the UTC day before the 00:45 slot', async () => {
    const tz = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    try {
      const w = await world(['mini']);
      await refresh('mini', 'done');
      const run = nightly(w.root, 5 * 60_000, { enqueue: async (j) => await enqueueJob(testDb(), j) });
      const out = await handler(run)(await reportJob(), run.ctx);
      expect(out).toMatchObject({ status: 'done', result: { day: '2026-11-02' } });
      expect(firstLines(run.posts)).toEqual(['ORION NIGHTLY dev 2026-11-02: 1 assets ok']);
      const [full] = await pendingSnapshots(testDb());
      expect(full).toMatchObject({ kind: 'full', day: '2026-11-02' });
      expect((JSON.parse(full!.body) as { body: { day: string } }).body.day).toBe('2026-11-02');
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });

  it('nightly_report: a stale report day, a failed refresh and an OUTSIDE fetch line are each an alert', async () => {
    const w = await world(['mini', 'other', 'third']);
    const stale = { ...cleanReport(), report_error: { code: 'report_stale', message: 'holder-yield report day 2026-10-28 is 6 days behind the tick (2026-11-03); a report flow has stopped' } };
    await refresh('mini', 'done', { report: stale, fetchLines: [], alertFlags: [], levels: 0 });
    await testDb().run("UPDATE jobs SET last_error = 'missing_rpc_url: UNSET_RPC_URL is not set', attempts = 2 WHERE id = (SELECT id FROM jobs WHERE asset_id = 'mini')");
    await refresh('other', 'failed', { report: { ...cleanReport('other'), outcome: 'error', ingest: null, holder_yield: null, error: { code: 'missing_rpc_url', message: 'UNSET_RPC_URL is not set' } }, fetchLines: [], alertFlags: [], levels: 0, alerted: true });
    await testDb().run("UPDATE jobs SET last_error = 'missing_rpc_url: UNSET_RPC_URL is not set', attempts = 2 WHERE asset_id = 'other'");
    const flagged = ['THIRD fetch ok', '    check price_usd vs http_json:x: 10 vs 12 (20.00% OUTSIDE 2%)'];
    await refresh('third', 'done', { report: cleanReport('third'), fetchLines: flagged, alertFlags: [flagged[1]], levels: 0 });
    const run = nightly(w.root, 30 * 60_000);
    const out = await handler(run)(await reportJob(), run.ctx);
    expect(out).toMatchObject({ status: 'done', result: { alerts: 3 } });
    const text = run.posts.join('\n');
    expect(text.split('\n')[0]).toBe('ORION ALERT dev nightly 2026-11-02: 3 alert(s)');
    expect(text).toContain('HOLDER YIELD MINI report_stale: holder-yield report day 2026-10-28 is 6 days behind');
    expect(text).toContain('OTHER job failed after 2 attempts: missing_rpc_url: UNSET_RPC_URL is not set');
    expect(text).toContain('check price_usd vs http_json:x: 10 vs 12 (20.00% OUTSIDE 2%)');
  });

  it('nightly_report: CONFIG CHANGED since the last delivered nightly, RESUMED short of the API refill, WATCH FIRING lines', async () => {
    // other's fee series is an API series that refills only 30 days back.
    const api = asId('other').replace('holder_flows:', '  flow_usd.api: { type: flow, unit: usd, staleness_days: 45, source: { type: defillama, slug: x, data_type: dailyFees, backfill_days: 30 } }\nholder_flows:');
    const w = await world(['mini', 'other'], ['mini', 'other'], { other: api });
    // Yesterday's delivered report saw other at hash-old.
    const prevSlot = new Date(SLOT_MS - 86_400_000).toISOString();
    const prev = (await enqueueJob(testDb(), { kind: 'nightly_report', assetId: null, slot: prevSlot }))!;
    await testDb().run("UPDATE jobs SET status = 'done', result_json = $2 WHERE id = $1", [
      prev.id, JSON.stringify({ delivered: true, configHashes: { mini: 'hash-mini', other: 'hash-old' } }),
    ]);
    // other was paused 41 days and resumed after yesterday's slot.
    await setRegistryState(testDb(), 'other', 'active', 'paused', { at: '2026-09-22T00:00:00.000Z', by: 'mike', reason: 'x', releaseTag: null });
    await setRegistryState(testDb(), 'other', 'paused', 'active', { at: '2026-11-02T12:00:00.000Z', by: 'mike', reason: null, releaseTag: null });
    await putWatchStates(testDb(), [{ assetId: 'mini', metricKey: 'stats_price', rule: 'outside', firing: true, since: '2026-11-01T05:15:00.000Z', lastValue: 10.1 }]);
    await refresh('mini', 'done');
    await refresh('other', 'done');
    const run = nightly(w.root, 30 * 60_000);
    const out = await handler(run)(await reportJob(), run.ctx);
    expect(out).toMatchObject({ status: 'done', result: { configHashes: { mini: 'hash-mini', other: 'hash-other' } } });
    const lines = run.posts[0]!.split('\n');
    expect(lines).toContain('CONFIG CHANGED OTHER');
    expect(lines).not.toContain('CONFIG CHANGED MINI');
    expect(lines).toContain('RESUMED OTHER after 41 days; API series refill only 30 days back');
    expect(lines).toContain('WATCH FIRING MINI: stats_price outside 10.1 since 2026-11-01');
  });

  it('nightly_report: a report that cannot be built is still announced as an ALERT', async () => {
    const w = await world(['mini']);
    await refresh('mini', 'done');
    const broken: JobContext['db'] = new Proxy(testDb(), {
      get: (t, p) => (p === 'all' ? async () => { throw new Error('connection reset'); } : Reflect.get(t, p)),
    });
    const run = nightly(w.root, 30 * 60_000, { db: broken });
    const out = await handler(run)(await reportJob(), run.ctx);
    expect(out).toMatchObject({ status: 'failed', error: 'nightly report not built: connection reset' });
    expect(run.posts).toEqual(['ORION ALERT dev nightly 2026-11-02: report not built: connection reset']);
    expect(run.pings).toEqual([]);
  });

  it('nightly_report: a long report is split per asset under 3,900 characters, the ALERT line first', async () => {
    const ids = Array.from({ length: 40 }, (_, i) => `a${String(i).padStart(2, '0')}`);
    const w = await world(ids);
    for (const id of ids) await refresh(id, 'done');
    await testDb().run("UPDATE jobs SET result_json = jsonb_set(result_json::jsonb, '{report,ingest,sources_failed}', '[\"http_json:https://api.example.test/stats\"]')::json WHERE asset_id = 'a00'");
    const run = nightly(w.root, 30 * 60_000);
    await handler(run)(await reportJob(), run.ctx);
    expect(run.posts.length).toBeGreaterThan(1);
    expect(run.posts.every((p) => p.length <= 3900)).toBe(true);
    expect(firstLines(run.posts)[0]).toBe('ORION ALERT dev nightly 2026-11-02: 1 alert(s)');
    expect(run.posts.slice(1).every((p) => p.startsWith('== A'))).toBe(true);
  });

  it('nightly_report: an unset webhook is not delivered, so the dead-man is not pinged (I-1)', async () => {
    const w = await world(['mini']);
    await refresh('mini', 'done');
    const notify = slackNotifier({ webhookUrl: undefined, fetch: (async () => new Response('x')) as typeof fetch, sleep: async () => undefined, log: () => undefined });
    const run = nightly(w.root, 30 * 60_000, { notify });
    const out = await handler(run)(await reportJob(), run.ctx);
    expect(out).toMatchObject({ status: 'done', result: { delivered: false, deadman: false, undelivered: 1 } });
    expect(run.pings).toEqual([]);
  });

  it('nightly_report: PUBLISH OFF when ORION_PUBLISH is off; PUBLISH PENDING (an alert) for unpushed snapshots over 1 h old (I-2)', async () => {
    const w = await world(['mini']);
    await refresh('mini', 'done');
    const off = nightly(w.root, 30 * 60_000);
    off.ctx = { ...off.ctx, envVars: { ...off.ctx.envVars, ORION_PUBLISH: 'off' } };
    await handler(off)(await reportJob(), off.ctx);
    const offLines = off.posts.join('\n').split('\n');
    expect(offLines).toContain('PUBLISH OFF');
    expect(offLines.some((l) => l.startsWith('PUBLISH PENDING'))).toBe(false);

    // Two snapshots stuck since the day before, and the full one the run above stored; one 20 min old does not count yet.
    const env = { env: 'dev' as const, seq: 0, releaseTag: null };
    for (const [kind, ms] of [['full', -24 * 3_600_000], ['levels', -23 * 3_600_000], ['levels', 24 * 3_600_000 + 10 * 60_000]] as const) {
      await insertSnapshot(testDb(), { kind, day: null, envelope: buildEnvelope(kind, { assets: {} }, { ...env, now: new Date(SLOT_MS + ms) }) });
    }
    const next = '2026-11-04T00:45:00.000Z';
    await refresh('mini', 'done', undefined, next);
    const run = nightly(w.root, 24 * 3_600_000 + 30 * 60_000);
    run.ctx = { ...run.ctx, envVars: { ...run.ctx.envVars, ORION_PUBLISH: 'git:git@github.com:masha256/orion-data-staging.git#main' } };
    const out = await handler(run)(await reportJob(next), run.ctx);
    const lines = run.posts.join('\n').split('\n');
    expect(lines).toContain(`PUBLISH PENDING 3 snapshot(s), oldest ${new Date(SLOT_MS - 24 * 3_600_000).toISOString()}`);
    expect(lines).not.toContain('PUBLISH OFF');
    expect(lines[0]).toBe('ORION ALERT dev nightly 2026-11-03: 1 alert(s)');
    expect(out).toMatchObject({ result: { alerts: 1 } });
  });

  it('nightly_report: an asset whose flows lag the report day is published at its last complete day, with LAG in Slack (I-7)', async () => {
    const hype = `${readFileSync(fileURLToPath(new URL('../fixtures/hype.yaml', import.meta.url)), 'utf8')}
reporting:
  window_days: 10
  haircuts: { buyback: 0 }
  income:
    lines:
      - { id: buyback, to: holders, metric: flow_usd.buyback }
`;
    const w = await world(['mini', 'hype'], ['mini', 'hype'], { hype });
    for (let i = 0; i < 20; i++) {
      const day = addDays('2026-10-30', -i); // 3 days behind the 2026-11-02 report day
      await insertObservation(testDb(), {
        assetId: 'hype', metricKey: 'flow_usd.buyback', observedAt: `${addDays(day, 1)}T00:00:00.000Z`, periodDays: 1, value: 2, source: 'api', fetchedAt: at(0),
      });
    }
    await refresh('mini', 'done');
    await refresh('hype', 'done', { report: cleanReport('hype'), fetchLines: [], alertFlags: [], levels: 0 });
    const run = nightly(w.root, 30 * 60_000);
    await handler(run)(await reportJob(), run.ctx);
    const lines = run.posts.join('\n').split('\n');
    expect(lines).toContain('LAG HYPE 3d');
    expect(lines.some((l) => l.startsWith('LAG MINI'))).toBe(false);
    const full = (await pendingSnapshots(testDb())).find((r) => r.kind === 'full')!;
    const body = (JSON.parse(full.body) as { body: { day: string; assets: Record<string, { report_day: string | null; lag_days: number | null; report: { day: string } | null }> } }).body;
    expect(body.day).toBe('2026-11-02');
    expect(body.assets.hype).toMatchObject({ report_day: '2026-10-30', lag_days: 3 });
    expect(body.assets.hype!.report!.day).toBe('2026-10-30');
  });

  it('nightly_report: the daemon runs the nightly_report handler', () => {
    expect(defaultHandlers().nightly_report).toBe(nightlyReportHandler);
  });
});
