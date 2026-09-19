import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/connection.js';
import { getCursor } from '../../src/db/fetchCursors.js';
import { getObservationsByIds, insertObservation, listActiveObservations } from '../../src/db/observations.js';
import { findFlowConflicts, parseMarketChart, priceAt, scanFlowGroup, type FlowScanArgs } from '../../src/ingest/flow.js';
import { buildPlan } from '../../src/ingest/plan.js';
import type { RpcTransport, TransferLog } from '../../src/ingest/transport/rpc.js';
import { CG_CHART, harness, hourlyPrices, NOW, type Harness } from '../helpers/fetchHarness.js';
import { POOL, SAFE } from '../helpers/ingestAsset.js';

const STRANGER = '0x9999999999999999999999999999999999999999';
const E18 = 10n ** 18n;
const ms = (iso: string) => Date.parse(iso);

/** Price 10 until 2026-09-17T00:00Z, 20 from then on. */
const stepPrices = () => hourlyPrices('2026-09-10T00:00:00Z', '2026-09-19T12:00:00Z', (t) => (t < ms('2026-09-17T00:00:00Z') ? 10 : 20));

function world(over: Parameters<typeof harness>[0] = {}): Harness & { logs: Omit<TransferLog, 'timestamp'>[] } {
  const probe = harness();
  const at = (iso: string) => probe.rpc.blockAtOrAfter(ms(iso) / 1000);
  let n = 0;
  const log = (iso: string, from: string, tokens: bigint): Omit<TransferLog, 'timestamp'> => ({
    blockNumber: at(iso), logIndex: n++, txHash: `0xtx${n}`, from, value: tokens * E18,
  });
  const logs = [
    log('2026-09-16T10:00:00Z', POOL, 2n),
    log('2026-09-16T23:59:58Z', SAFE.toUpperCase().replace('0X', '0x'), 100n), // last block of the 16th; mixed-case sender
    log('2026-09-17T00:00:00Z', POOL, 3n), // first block of the 17th (its timestamp is 00:00:01)
    log('2026-09-17T12:00:00Z', STRANGER, 5n),
    log('2026-09-19T01:00:00Z', POOL, 7n), // the 19th is not complete at NOW
  ];
  return { ...harness({ routes: { [CG_CHART]: stepPrices() }, logs, ...over }), logs };
}

function argsFor(h: Harness, over: Partial<FlowScanArgs> = {}): Promise<FlowScanArgs> {
  return h.rpc.latestBlock().then((latest) => ({
    db: h.db, asset: h.loaded.config, group: buildPlan(h.loaded.config).flowGroups[0], rpc: h.rpc, latest, http: h.http, env: {},
    sleep: async () => undefined, now: h.deps.now(), backfillDays: 3, rescan: false, adopt: false, dryRun: false, ...over,
  }));
}

const rows = (db: Db, metric: string) => listActiveObservations(db, 'mini', metric).map((o) => [o.observedAt.slice(0, 10), o.value]);

describe('price series', () => {
  it('parses market_chart prices and refuses malformed or non-positive points', () => {
    expect(parseMarketChart({ prices: [[2000, 5], [1000, 4]] }, 'x')).toEqual([{ ts: 1000, price: 4 }, { ts: 2000, price: 5 }]);
    expect(() => parseMarketChart({}, 'x')).toThrow(/x: no prices/);
    expect(() => parseMarketChart({ prices: [[1000, 0]] }, 'x')).toThrow(/malformed/);
  });
  it('uses the newest hourly point at or before the time, then the newest daily point, and never interpolates', () => {
    const series = { hourly: [{ ts: 1000, price: 10 }, { ts: 2000, price: 20 }], daily: [{ ts: 100, price: 1 }, { ts: 500, price: 5 }] };
    expect(priceAt(series, 1999)).toBe(10);
    expect(priceAt(series, 2000)).toBe(20);
    expect(priceAt(series, 999)).toBe(5);
    expect(priceAt(series, 100)).toBe(1);
    expect(priceAt(series, 99)).toBeNull();
  });
});

describe('scanFlowGroup', () => {
  it('writes one row per metric per completed UTC day, valued at the hour of each transfer', async () => {
    const h = world();
    const r = await scanFlowGroup(await argsFor(h));
    expect(r.outcome).toMatchObject({ status: 'ok', error: null, metricsWritten: ['flow_usd.fees', 'flow_tokens.fees', 'flow_usd.fees_programmatic'] });
    // 16th: 2 + 100 tokens at 10 USD. 17th: 3 tokens at 20 USD (the stranger's 5 are excluded). 18th: nothing, written as 0.
    expect(rows(h.db, 'flow_usd.fees')).toEqual([['2026-09-17', 1020], ['2026-09-18', 60], ['2026-09-19', 0]]);
    expect(rows(h.db, 'flow_tokens.fees')).toEqual([['2026-09-17', 102], ['2026-09-18', 3], ['2026-09-19', 0]]);
    expect(rows(h.db, 'flow_usd.fees_programmatic')).toEqual([['2026-09-17', 20], ['2026-09-18', 60], ['2026-09-19', 0]]); // pool only

    const first = listActiveObservations(h.db, 'mini', 'flow_usd.fees')[0];
    expect(first).toMatchObject({ observedAt: '2026-09-17T00:00:00.000Z', periodDays: 1, source: 'onchain', status: 'confirmed' });
    const detail = JSON.parse(first.sourceDetail!) as { day: string; blocks: number[]; senders: Record<string, { count: number; tokens: number }> };
    expect(detail.day).toBe('2026-09-16');
    expect(detail.senders).toEqual({ pool: { count: 1, tokens: 2 }, safe: { count: 1, tokens: 100 } });
    expect(detail.blocks[1] - detail.blocks[0] + 1).toBe(43_200);
    expect(r.written).toHaveLength(9);
    expect(r.daily.get('flow_tokens.fees')).toEqual([{ day: '2026-09-16', value: 102 }, { day: '2026-09-17', value: 3 }, { day: '2026-09-18', value: 0 }]);
  });

  it('reports unlisted senders and keeps them out of every sum', async () => {
    const h = world();
    const r = await scanFlowGroup(await argsFor(h));
    expect(r.unlisted).toEqual([{ txHash: '0xtx4', logIndex: 3, blockNumber: Number(h.logs[3].blockNumber), from: STRANGER, tokens: 5, day: '2026-09-17' }]);
    expect(r.outcome.unlistedTransfers).toEqual(r.unlisted);
  });

  it('asks for at most 2000 blocks per call and covers the range without gaps', async () => {
    const h = world();
    await scanFlowGroup(await argsFor(h));
    const ranges = h.rpc.stats.logRanges;
    expect(ranges.every(([from, to]) => to - from + 1n <= 2000n)).toBe(true);
    expect(ranges[0][0]).toBe(h.rpc.blockAtOrAfter(ms('2026-09-16T00:00:00Z') / 1000));
    expect(ranges.at(-1)![1]).toBe(h.rpc.blockAtOrAfter(ms('2026-09-19T00:00:00Z') / 1000) - 1n);
    for (let i = 1; i < ranges.length; i++) expect(ranges[i][0]).toBe(ranges[i - 1][1] + 1n);
  });

  it('advances the cursor to the last block of the last complete day, and resumes from it', async () => {
    const h = world();
    const group = buildPlan(h.loaded.config).flowGroups[0];
    await scanFlowGroup(await argsFor(h));
    expect(getCursor(h.db, 'mini', group.scanKey)).toEqual({
      lastDay: '2026-09-18', lastBlock: Number(h.rpc.blockAtOrAfter(ms('2026-09-19T00:00:00Z') / 1000)) - 1,
    });

    const calls = h.rpc.stats.logRanges.length;
    const again = await scanFlowGroup(await argsFor(h));
    expect(again.outcome.status).toBe('ok');
    expect(again.outcome.notes[0]).toMatch(/no completed day/);
    expect(h.rpc.stats.logRanges.length).toBe(calls);

    const nextDay = world({ db: h.db, now: new Date(NOW.getTime() + 86_400_000) });
    const r = await scanFlowGroup(await argsFor(nextDay));
    expect(r.written.map((w) => [w.metricKey, w.observedAt.slice(0, 10), w.value])).toEqual([
      ['flow_usd.fees', '2026-09-20', 140], ['flow_tokens.fees', '2026-09-20', 7], ['flow_usd.fees_programmatic', '2026-09-20', 140],
    ]);
  });

  it('keeps committed days when a chunk keeps failing, and resumes after them', async () => {
    const h = world();
    const secondDay = h.rpc.blockAtOrAfter(ms('2026-09-17T00:00:00Z') / 1000);
    const flaky: RpcTransport = { ...h.rpc, getTransferLogs: async (q) => (q.fromBlock >= secondDay ? Promise.reject(new Error('rate limited')) : h.rpc.getTransferLogs(q)) };
    const broken = await scanFlowGroup(await argsFor(h, { rpc: flaky }));
    expect(broken.outcome.status).toBe('failed');
    expect(broken.outcome.error).toMatch(/eth_getLogs failed.*rate limited/);
    expect(rows(h.db, 'flow_tokens.fees')).toEqual([['2026-09-17', 102]]);
    expect(getCursor(h.db, 'mini', buildPlan(h.loaded.config).flowGroups[0].scanKey)!.lastDay).toBe('2026-09-16');

    const resumed = await scanFlowGroup(await argsFor(h));
    expect(resumed.written.map((w) => w.observedAt.slice(0, 10))).not.toContain('2026-09-17');
    expect(rows(h.db, 'flow_tokens.fees')).toEqual([['2026-09-17', 102], ['2026-09-18', 3], ['2026-09-19', 0]]);
  });

  it('is idempotent: a forced re-scan supersedes the same days', async () => {
    const h = world();
    await scanFlowGroup(await argsFor(h));
    const before = listActiveObservations(h.db, 'mini', 'flow_usd.fees').map((o) => o.id);
    await scanFlowGroup(await argsFor(h, { rescan: true }));
    expect(rows(h.db, 'flow_usd.fees')).toEqual([['2026-09-17', 1020], ['2026-09-18', 60], ['2026-09-19', 0]]);
    expect(getObservationsByIds(h.db, before).every((o) => o.supersededBy !== null)).toBe(true);
  });

  it('falls back to the newest daily price for transfers older than the hourly series', async () => {
    const h = world({
      routes: {
        [`${CG_CHART}?vs_currency=usd&days=90`]: hourlyPrices('2026-09-17T00:00:00Z', '2026-09-19T12:00:00Z', () => 20),
        [`${CG_CHART}?vs_currency=usd&days=91`]: { prices: [[ms('2026-09-15T00:00:00Z'), 7], [ms('2026-09-16T00:00:00Z'), 8], [ms('2026-09-17T00:00:00Z'), 9]] },
      },
    });
    await scanFlowGroup(await argsFor(h));
    expect(rows(h.db, 'flow_usd.fees')[0]).toEqual(['2026-09-17', 102 * 8]);
    expect(h.http.calls.map((c) => c.url)).toEqual([`${CG_CHART}?vs_currency=usd&days=90`, `${CG_CHART}?vs_currency=usd&days=91`]);
  });

  it('does not make the daily call when the hourly series covers the range', async () => {
    const h = world();
    await scanFlowGroup(await argsFor(h));
    expect(h.http.calls.map((c) => c.url)).toEqual([`${CG_CHART}?vs_currency=usd&days=90`]);
  });

  it('fails the day rather than value a transfer that has no earlier price point', async () => {
    const h = world({
      routes: {
        [`${CG_CHART}?vs_currency=usd&days=90`]: hourlyPrices('2026-09-17T00:00:00Z', '2026-09-19T12:00:00Z', () => 20),
        [`${CG_CHART}?vs_currency=usd&days=91`]: { prices: [[ms('2026-09-17T00:00:00Z'), 9]] },
      },
    });
    const r = await scanFlowGroup(await argsFor(h));
    expect(r.outcome.status).toBe('failed');
    expect(r.outcome.error).toMatch(/no mini-token price point at or before 2026-09-16T10:00:01.000Z/);
    expect(listActiveObservations(h.db, 'mini')).toEqual([]);
  });

  it('refuses to write over manual rows without --adopt, and says what --adopt would do', async () => {
    const h = world();
    const manual = insertObservation(h.db, { assetId: 'mini', metricKey: 'flow_usd.fees', observedAt: '2026-09-18', periodDays: 30, value: 5000, source: 'manual', fetchedAt: NOW.toISOString() });
    const r = await scanFlowGroup(await argsFor(h));
    expect(r.outcome.status).toBe('skipped');
    expect(r.outcome.conflicts).toEqual([
      { metricKey: 'flow_usd.fees', observationId: manual.id, source: 'manual', observedAt: '2026-09-18T00:00:00.000Z', periodDays: 30, adoptable: true },
    ]);
    expect(r.outcome.notes.join(' ')).toMatch(/--adopt/);
    expect(listActiveObservations(h.db, 'mini').map((o) => o.id)).toEqual([manual.id]); // no member of the group was written
    expect(getCursor(h.db, 'mini', buildPlan(h.loaded.config).flowGroups[0].scanKey)).toBeNull();
    expect(h.rpc.stats.logRanges).toEqual([]);
  });

  it('with --adopt, rejects the manual rows and writes the fetched ones', async () => {
    const h = world();
    const manual = insertObservation(h.db, { assetId: 'mini', metricKey: 'flow_usd.fees', observedAt: '2026-09-18', periodDays: 30, value: 5000, source: 'manual', fetchedAt: NOW.toISOString() });
    const older = insertObservation(h.db, { assetId: 'mini', metricKey: 'flow_usd.fees', observedAt: '2026-08-19', periodDays: 30, value: 4000, source: 'manual', fetchedAt: NOW.toISOString() });
    const r = await scanFlowGroup(await argsFor(h, { adopt: true }));
    expect(r.outcome.status).toBe('ok');
    expect(r.outcome.retiredObservationIds).toEqual([manual.id]);
    expect(getObservationsByIds(h.db, [manual.id])[0].status).toBe('rejected');
    expect(getObservationsByIds(h.db, [older.id])[0].status).toBe('confirmed'); // it ends before the scanned days: no overlap
    expect(rows(h.db, 'flow_usd.fees')).toEqual([['2026-08-19', 4000], ['2026-09-17', 1020], ['2026-09-18', 60], ['2026-09-19', 0]]);
  });

  it('never adopts over a row that is not manual', async () => {
    const h = world();
    insertObservation(h.db, { assetId: 'mini', metricKey: 'flow_tokens.fees', observedAt: '2026-09-18', periodDays: 2, value: 9, source: 'api', fetchedAt: NOW.toISOString() });
    const r = await scanFlowGroup(await argsFor(h, { adopt: true }));
    expect(r.outcome.status).toBe('skipped');
    expect(r.outcome.conflicts[0]).toMatchObject({ source: 'api', adoptable: false });
    expect(r.outcome.notes.join(' ')).toMatch(/orion data reject/);
  });

  it('finds conflicts by overlap, ignoring rows that only touch the range', () => {
    const h = world();
    const touching = insertObservation(h.db, { assetId: 'mini', metricKey: 'flow_usd.fees', observedAt: '2026-09-16', periodDays: 30, value: 1, source: 'manual', fetchedAt: NOW.toISOString() });
    expect(findFlowConflicts(h.db, 'mini', 'flow_usd.fees', ms('2026-09-16T00:00:00Z'), ms('2026-09-19T00:00:00Z'))).toEqual([]);
    expect(findFlowConflicts(h.db, 'mini', 'flow_usd.fees', ms('2026-09-15T00:00:00Z'), ms('2026-09-19T00:00:00Z')).map((c) => c.observationId)).toEqual([touching.id]);
  });

  it('writes nothing on a dry run and still returns the day values', async () => {
    const h = world();
    const r = await scanFlowGroup(await argsFor(h, { dryRun: true }));
    expect(listActiveObservations(h.db, 'mini')).toEqual([]);
    expect(getCursor(h.db, 'mini', buildPlan(h.loaded.config).flowGroups[0].scanKey)).toBeNull();
    expect(r.written).toHaveLength(9);
    expect(r.written.every((w) => w.observationId === null)).toBe(true);
    expect(r.daily.get('flow_usd.fees')![0]).toEqual({ day: '2026-09-16', value: 1020 });
  });

  it('reports progress once per day', async () => {
    const h = world();
    const lines: string[] = [];
    await scanFlowGroup(await argsFor(h, { onProgress: (l) => lines.push(l) }));
    expect(lines).toEqual([
      'transfer_flow:token>burn_sink[pool,safe] 2026-09-16: 2 transfers',
      'transfer_flow:token>burn_sink[pool,safe] 2026-09-17: 1 transfers, 1 unlisted',
      'transfer_flow:token>burn_sink[pool,safe] 2026-09-18: 0 transfers',
    ]);
  });
});
