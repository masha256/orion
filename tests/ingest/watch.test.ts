import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildProgram } from '../../src/cli/program.js';
import { openDb, type Db } from '../../src/db/connection.js';
import { listFetchRuns } from '../../src/db/fetchRuns.js';
import { insertObservation, listActiveObservations } from '../../src/db/observations.js';
import { fetchAsset } from '../../src/ingest/run.js';
import type { TransferLog } from '../../src/ingest/transport/rpc.js';
import type { WrittenObservation } from '../../src/ingest/types.js';
import { evaluateWatches } from '../../src/ingest/watch.js';
import { defaultRoutes, GENESIS_TS, harness, NOW, STATS, type Harness } from '../helpers/fetchHarness.js';
import { POOL } from '../helpers/ingestAsset.js';
import { watchAsset, watchAssetYaml } from '../helpers/watchAsset.js';

const E18 = 10n ** 18n;
const blockAt = (iso: string) => BigInt(Math.ceil((Date.parse(iso) / 1000 - GENESIS_TS) / 2));
const asset = watchAsset().config;

/** A flow day D is stored at its period end, D+1 00:00Z. */
const flowRow = (day: string, value: number): WrittenObservation => ({
  metricKey: 'flow_usd.revenue', value, observedAt: new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString(), periodDays: 1, source: 'onchain', observationId: null,
});
const levelRow = (metricKey: string, value: number, observedAt = '2026-09-19T12:00:05.000Z'): WrittenObservation => ({
  metricKey, value, observedAt, periodDays: null, source: 'api', observationId: null,
});
const snapshot = (rows: Record<string, Record<string, number>>) => new Map(Object.entries(rows).map(([m, byAt]) => [m, new Map(Object.entries(byAt))]));
const noPrevious = () => null;

describe('evaluateWatches', () => {
  it('above fires for a new flow day over the threshold', () => {
    expect(evaluateWatches(asset, new Map(), [flowRow('2026-09-17', 1500)], noPrevious)).toEqual([
      { metric: 'flow_usd.revenue', rule: 'above', value: 1500, previous: null, day: '2026-09-17' },
    ]);
  });

  it('stays quiet for a flow day at or under the threshold', () => {
    expect(evaluateWatches(asset, new Map(), [flowRow('2026-09-17', 1000), flowRow('2026-09-18', 3)], noPrevious)).toEqual([]);
  });

  it('reports a flow day once across two fetches', () => {
    const before = snapshot({ 'flow_usd.revenue': { '2026-09-18T00:00:00.000Z': 1500 } });
    expect(evaluateWatches(asset, before, [flowRow('2026-09-17', 1600)], noPrevious)).toEqual([]);
  });

  it('fires when a re-read day newly crosses', () => {
    const before = snapshot({ 'flow_usd.revenue': { '2026-09-18T00:00:00.000Z': 800 } });
    expect(evaluateWatches(asset, before, [flowRow('2026-09-17', 1200)], noPrevious)).toEqual([
      { metric: 'flow_usd.revenue', rule: 'above', value: 1200, previous: 800, day: '2026-09-17' },
    ]);
  });

  it('change_pct fires on a 6% move and not on 4%', () => {
    const previous = (metric: string) => (metric === 'stats_price' ? 100 : null);
    expect(evaluateWatches(asset, new Map(), [levelRow('stats_price', 106)], previous)).toEqual([
      { metric: 'stats_price', rule: 'change_pct', value: 106, previous: 100, day: '2026-09-19' },
    ]);
    expect(evaluateWatches(asset, new Map(), [levelRow('stats_price', 104)], previous)).toEqual([]);
    expect(evaluateWatches(asset, new Map(), [levelRow('stats_price', 94)], previous)).toHaveLength(1); // a fall counts too
  });

  it('change_pct from a previous 0: a non-zero reading fires, 0 again does not', () => {
    const zero = () => 0;
    expect(evaluateWatches(asset, new Map(), [levelRow('stats_price', 3)], zero)).toEqual([
      { metric: 'stats_price', rule: 'change_pct', value: 3, previous: 0, day: '2026-09-19' },
    ]);
    expect(evaluateWatches(asset, new Map(), [levelRow('stats_price', 0)], zero)).toEqual([]);
  });

  it('change_pct needs a previous reading: the first one never fires', () => {
    expect(evaluateWatches(asset, new Map(), [levelRow('stats_price', 106)], noPrevious)).toEqual([]);
  });

  it('asks for the previous level strictly before the new reading', () => {
    const asked: [string, string][] = [];
    evaluateWatches(asset, new Map(), [levelRow('stats_price', 106)], (m, at) => (asked.push([m, at]), null));
    expect(asked).toEqual([['stats_price', '2026-09-19T12:00:05.000Z']]);
  });

  it('outside fires below lo and above hi, not inside the band, and carries the previous reading', () => {
    const previous = () => 0.06;
    expect(evaluateWatches(asset, new Map(), [levelRow('stats_apr', 0.05)], previous)).toEqual([
      { metric: 'stats_apr', rule: 'outside', value: 0.05, previous: 0.06, day: '2026-09-19' },
    ]);
    expect(evaluateWatches(asset, new Map(), [levelRow('stats_apr', 0.07)], previous)).toHaveLength(1);
    expect(evaluateWatches(asset, new Map(), [levelRow('stats_apr', 0.063)], previous)).toEqual([]);
  });

  it('ignores metrics without a watch', () => {
    expect(evaluateWatches(asset, new Map(), [{ ...flowRow('2026-09-17', 1e9), metricKey: 'flow_usd.fees' }, levelRow('price_usd', 1e9)], () => 1)).toEqual([]);
  });
});

/** The pool sends 3 tokens (30 USD at price 10) to the treasury on 2026-09-17; the stats endpoint reads price 10.1. */
const LOGS: Omit<TransferLog, 'timestamp'>[] = [{ blockNumber: blockAt('2026-09-17T12:00:00Z'), logIndex: 0, txHash: '0xa', from: POOL, value: 3n * E18 }];
const statsRoute = (apr: number) => ({ [STATS]: { ...(defaultRoutes()[STATS] as object), apr: String(apr) } });
function world(opts: { above?: number; apr?: number; db?: Db; now?: Date } = {}): Harness {
  return harness({ loaded: watchAsset({ above: opts.above ?? 20 }), logs: LOGS, routes: statsRoute(opts.apr ?? 0.07), db: opts.db, now: opts.now });
}
const fetch = (h: Harness, dryRun = false) => fetchAsset(h.db, h.loaded, h.deps.now(), h.deps, { dryRun });
const count = (db: Db, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('fetchAsset: watches', () => {
  it('reports the firings in the result, from the stored rows before the fetch', async () => {
    const h = world();
    insertObservation(h.db, { assetId: 'mini', metricKey: 'stats_price', observedAt: '2026-09-18T12:00:00Z', value: 9.5, source: 'api', fetchedAt: '2026-09-18T12:00:00Z' });
    const r = await fetch(h);
    expect(r.watch).toEqual([
      { metric: 'stats_price', rule: 'change_pct', value: 10.1, previous: 9.5, day: '2026-09-19' },
      { metric: 'stats_apr', rule: 'outside', value: 0.07, previous: null, day: '2026-09-19' },
      { metric: 'flow_usd.revenue', rule: 'above', value: 30, previous: null, day: '2026-09-17' },
    ]);
  });

  it('outside fires on every fetch while outside', async () => {
    const h = world();
    const first = await fetch(h);
    const second = await fetch(world({ db: h.db, now: new Date(NOW.getTime() + 30 * 60_000) })); // a later reading: the first is now the previous one
    expect(first.watch.filter((f) => f.rule === 'outside')).toEqual([{ metric: 'stats_apr', rule: 'outside', value: 0.07, previous: null, day: '2026-09-19' }]);
    expect(second.watch.filter((f) => f.rule === 'outside')).toEqual([{ metric: 'stats_apr', rule: 'outside', value: 0.07, previous: 0.07, day: '2026-09-19' }]);
    expect(second.watch.filter((f) => f.rule === 'above')).toEqual([]); // the flow day was reported by the first fetch
  });

  it('no anomaly (triggers are the tick\'s: tests/app/tick.test.ts asserts no trigger firing)', async () => {
    const h = world();
    const anomalies = count(h.db, 'anomalies');
    const r = await fetch(h);
    expect(r.watch.length).toBeGreaterThan(0);
    expect(r.anomalies).toEqual([]);
    expect(count(h.db, 'anomalies')).toBe(anomalies);
  });

  it('dry run computes firings and writes nothing', async () => {
    const h = world();
    const r = await fetch(h, true);
    expect(r.watch.map((f) => f.rule)).toEqual(['outside', 'above']);
    expect(r.fetchRunId).toBeNull();
    expect(count(h.db, 'fetch_runs')).toBe(0);
    expect(listActiveObservations(h.db, 'mini')).toEqual([]);
  });

  it('fetch_runs.detail_json.watch is stored when non-empty and absent when empty', async () => {
    const h = world();
    const fired = await fetch(h);
    const [stored] = listFetchRuns(h.db, 'mini', 1);
    expect(stored.detail.watch).toEqual(fired.watch);

    const quiet = await fetch(world({ db: h.db, apr: 0.06, now: new Date(NOW.getTime() + 30 * 60_000) })); // a later reading, inside the band; the flow day is already reported
    expect(quiet.watch).toEqual([]);
    const [latest] = listFetchRuns(h.db, 'mini', 1);
    expect(latest.id).toBe(quiet.fetchRunId);
    expect(latest.id).not.toBe(stored.id);
    expect(Object.keys(latest.detail)).toEqual(['sources']);
  });
});

describe('orion data fetch: watches', () => {
  it('data fetch prints a line `watch: <metric> <rule> <value> (was <previous>) <day>`', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orion-watch-cli-'));
    const h = world();
    const lines: string[] = [];
    const orion = (...args: string[]) =>
      buildProgram({ home, stdout: (l) => lines.push(l), now: () => NOW, ingestDeps: () => h.deps, stderr: () => undefined }).parseAsync(args, { from: 'user' });
    await orion('init');
    writeFileSync(join(home, 'assets', 'mini.yaml'), watchAssetYaml({ above: 20 }));
    const db = openDb(join(home, 'orion.db'));
    insertObservation(db, { assetId: 'mini', metricKey: 'stats_price', observedAt: '2026-09-18T12:00:00Z', value: 9.5, source: 'api', fetchedAt: '2026-09-18T12:00:00Z' });
    db.close();
    lines.length = 0;
    await orion('data', 'fetch', 'mini', '--dry-run');
    expect(lines).toContain('  watch: stats_price change_pct 10.1 (was 9.5) 2026-09-19');
    expect(lines).toContain('  watch: stats_apr outside 0.07 2026-09-19'); // no previous reading
    expect(lines).toContain('  watch: flow_usd.revenue above 30 2026-09-17');
  });
});
