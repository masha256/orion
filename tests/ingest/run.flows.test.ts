import { describe, expect, it } from 'vitest';
import { listAnomalies } from '../../src/db/anomalies.js';
import { getCursor } from '../../src/db/fetchCursors.js';
import { insertObservation, listActiveObservations } from '../../src/db/observations.js';
import { buildPlan } from '../../src/ingest/plan.js';
import { fetchAsset, type FetchDeps, type FetchResult } from '../../src/ingest/run.js';
import { addDays } from '../../src/ingest/time.js';
import type { TransferLog } from '../../src/ingest/transport/rpc.js';
import { fakeRpc } from '../helpers/fakeRpc.js';
import { CG_CHART, defaultCalls, GENESIS_TS, harness, hourlyPrices, LLAMA } from '../helpers/fetchHarness.js';
import { POOL } from '../helpers/ingestAsset.js';
import { useTestDb } from '../helpers/db.js';
import { TEST_PROVENANCE } from '../helpers/provenance.js';

const testDb = useTestDb();

const FLOW_ID = 'transfer_flow:token>burn_sink[pool,safe]';
const LLAMA_ID = 'defillama:mini:dailyHoldersRevenue';
const STRANGER = '0x9999999999999999999999999999999999999999';
const E18 = 10n ** 18n;
const source = (r: FetchResult, id: string) => r.sources.find((s) => s.sourceId === id)!;
const blockAt = (iso: string) => BigInt(Math.ceil((Date.parse(iso) / 1000 - GENESIS_TS) / 2));
const log = (iso: string, from: string, tokens: bigint, i: number): Omit<TransferLog, 'timestamp'> => ({
  blockNumber: blockAt(iso), logIndex: i, txHash: `0xtx${i}`, from, value: tokens * E18,
});

describe('fetchAsset: flows', () => {
  it('scans each flow group once and reports it as its own source', async () => {
    const h = harness(testDb(), { logs: [log('2026-09-17T12:00:00Z', POOL, 4n, 0)] });
    const lines: string[] = [];
    const r = await fetchAsset(h.db, h.loaded, h.deps.now(), h.deps, { onProgress: (l) => lines.push(l) });
    expect(source(r, FLOW_ID)).toMatchObject({ status: 'ok', metricsWritten: ['flow_usd.fees', 'flow_tokens.fees', 'flow_usd.fees_programmatic'] });
    expect((await listActiveObservations(h.db, 'mini', 'flow_usd.fees')).map((o) => o.value)).toEqual([0, 40, 0]);
    expect(r.written.filter((w) => w.periodDays === 1)).toHaveLength(9);
    expect(lines).toHaveLength(3);
    expect(r.outcome).toBe('ok');
  });

  it('raises one degrading unlisted_sender anomaly per sender, on the critical metric only', async () => {
    const h = harness(testDb(), { logs: [log('2026-09-17T12:00:00Z', STRANGER, 5n, 0), log('2026-09-18T12:00:00Z', STRANGER, 6n, 1)] });
    const r = await fetchAsset(h.db, h.loaded, h.deps.now(), h.deps);
    expect(r.anomalies).toHaveLength(1);
    expect(r.anomalies[0]).toMatchObject({ kind: 'unlisted_sender', metricKey: 'flow_usd.fees', dedupeKey: STRANGER, severity: 'degrading' });
    expect(r.anomalies[0].detail).toMatchObject({ sender: STRANGER, transfers: 2, tokens: 11, first: { tx: '0xtx0', day: '2026-09-17' }, last: { tx: '0xtx1', day: '2026-09-18' } });
    expect((await listActiveObservations(h.db, 'mini', 'flow_tokens.fees')).map((o) => o.value)).toEqual([0, 0, 0]); // excluded from the flow
    expect(await listAnomalies(h.db, { assetId: 'mini' })).toHaveLength(1);
  });

  it('forces a re-scan when --backfill-days is given, and resumes from the cursor otherwise', async () => {
    const h = harness(testDb());
    await fetchAsset(h.db, h.loaded, h.deps.now(), h.deps);
    const scanned = h.rpc.stats.logRanges.length;
    await fetchAsset(h.db, h.loaded, h.deps.now(), h.deps);
    expect(h.rpc.stats.logRanges.length).toBe(scanned);
    await fetchAsset(h.db, h.loaded, h.deps.now(), h.deps, { backfillDays: 2 });
    expect(h.rpc.stats.logRanges.length).toBeGreaterThan(scanned);
    expect(await listActiveObservations(h.db, 'mini', 'flow_usd.fees')).toHaveLength(3);
  });

  // Final review (T7b deferred): R20 on an incremental run. A --metric run without --backfill-days on a group that already
  // has a cursor scans on from the cursor, writes only the listed member's new day, and leaves the cursor; the next full
  // fetch then writes that day for every member, with one active row per day in each (no gap, no duplicate).
  it('an incremental --metric run on a group with a cursor writes only the listed member and leaves the cursor', async () => {
    const db = testDb();
    const group = ['flow_usd.fees', 'flow_tokens.fees', 'flow_usd.fees_programmatic'];
    const h = harness(db, { logs: [log('2026-09-17T12:00:00Z', POOL, 4n, 0)] });
    await fetchAsset(h.db, h.loaded, h.deps.now(), h.deps);
    const scanKey = buildPlan(h.loaded.config).flowGroups[0]!.scanKey;
    const cursor = await getCursor(db, 'mini', scanKey);
    expect(cursor).toMatchObject({ lastDay: '2026-09-18' });

    // A day later: the chain has a new day (2026-09-19) with a transfer.
    const next = new Date(Date.parse('2026-09-20T12:00:00.000Z'));
    const h2 = harness(db, { now: next, logs: [log('2026-09-17T12:00:00Z', POOL, 4n, 0), log('2026-09-19T12:00:00Z', POOL, 3n, 1)] });
    const r = await fetchAsset(h2.db, h2.loaded, h2.deps.now(), h2.deps, { metrics: ['flow_tokens.fees'] });
    expect(r.written.filter((w) => w.periodDays === 1).map((w) => [w.metricKey, w.observedAt, w.value])).toEqual([['flow_tokens.fees', '2026-09-20T00:00:00.000Z', 3]]);
    expect(source(r, FLOW_ID).notes.join(' ')).toMatch(/--metric: wrote only flow_tokens\.fees; flow_usd\.fees, flow_usd\.fees_programmatic share this scan/);
    expect(await getCursor(db, 'mini', scanKey)).toEqual(cursor);
    expect(await listActiveObservations(db, 'mini', 'flow_tokens.fees')).toHaveLength(4);
    for (const m of ['flow_usd.fees', 'flow_usd.fees_programmatic']) expect(await listActiveObservations(db, 'mini', m), m).toHaveLength(3);

    // The next full fetch resumes from the unmoved cursor: 2026-09-19 for every member, the listed one superseded in place.
    const full = await fetchAsset(h2.db, h2.loaded, h2.deps.now(), h2.deps);
    expect(new Set(full.written.filter((w) => w.periodDays === 1).map((w) => `${w.metricKey}@${w.observedAt}`))).toEqual(new Set(group.map((m) => `${m}@2026-09-20T00:00:00.000Z`)));
    expect(await getCursor(db, 'mini', scanKey)).toMatchObject({ lastDay: '2026-09-19' });
    for (const m of group) {
      const rows = await listActiveObservations(db, 'mini', m);
      expect(rows.map((o) => o.observedAt), m).toEqual(['2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20'].map((d) => `${d}T00:00:00.000Z`));
    }
    expect((await listActiveObservations(db, 'mini', 'flow_tokens.fees')).map((o) => o.value)).toEqual([0, 4, 0, 3]);
  });

  it('passes --adopt and --dry-run through to the scan', async () => {
    const h = harness(testDb());
    await insertObservation(h.db, { provenance: TEST_PROVENANCE, assetId: 'mini', metricKey: 'flow_usd.fees', observedAt: '2026-09-18', periodDays: 30, value: 5000, source: 'manual', fetchedAt: '2026-09-18T00:00:00Z' });
    const refused = await fetchAsset(h.db, h.loaded, h.deps.now(), h.deps);
    expect(source(refused, FLOW_ID).status).toBe('skipped');
    expect(refused.outcome).toBe('partial');
    const dry = await fetchAsset(h.db, h.loaded, h.deps.now(), h.deps, { adopt: true, dryRun: true });
    expect(source(dry, FLOW_ID).notes.join(' ')).toMatch(/--adopt would reject/);
    expect(await listActiveObservations(h.db, 'mini', 'flow_usd.fees')).toHaveLength(1);
    const adopted = await fetchAsset(h.db, h.loaded, h.deps.now(), h.deps, { adopt: true });
    expect(source(adopted, FLOW_ID).retiredObservationIds).toHaveLength(1);
    expect(await listActiveObservations(h.db, 'mini', 'flow_usd.fees')).toHaveLength(3);
  });

  // Ruling R20: a --metric run scans the whole group once but writes only the listed members, and leaves the shared cursor
  // alone, so the members it withheld get those days from the next full fetch (no gap in any member).
  it('a --metric narrowed to one member of a shared scan writes only it and leaves the cursor for the whole group', async () => {
    const h = harness(testDb(), { logs: [log('2026-09-17T12:00:00Z', POOL, 4n, 0)] });
    const group = ['flow_usd.fees', 'flow_tokens.fees', 'flow_usd.fees_programmatic'];
    const first = await fetchAsset(h.db, h.loaded, h.deps.now(), h.deps, { metrics: ['flow_tokens.fees'] });
    expect(new Set(first.written.filter((w) => w.periodDays === 1).map((w) => w.metricKey))).toEqual(new Set(['flow_tokens.fees']));
    expect(await listActiveObservations(h.db, 'mini', 'flow_tokens.fees')).toHaveLength(3);
    for (const metricKey of ['flow_usd.fees', 'flow_usd.fees_programmatic']) expect(await listActiveObservations(h.db, 'mini', metricKey), metricKey).toEqual([]);
    expect(await getCursor(h.db, 'mini', buildPlan(h.loaded.config).flowGroups[0]!.scanKey)).toBeNull();
    await fetchAsset(h.db, h.loaded, h.deps.now(), h.deps); // the next normal fetch fills every member's days
    for (const metricKey of group) {
      expect(await listActiveObservations(h.db, 'mini', metricKey), metricKey).toHaveLength(3);
    }
  });

  it('fails the flow group when the latest block cannot be read', async () => {
    const h = harness(testDb());
    h.rpc.latestBlock = async () => {
      throw new Error('connection refused');
    };
    const r = await fetchAsset(h.db, h.loaded, h.deps.now(), h.deps);
    expect(source(r, FLOW_ID)).toMatchObject({ status: 'failed', error: 'could not read the latest block: connection refused' });
  });

  describe('monthly cross-check', () => {
    // A 50-day backfill from 2026-09-19 covers all of August.
    const august = (value: number) => Array.from({ length: 31 }, (_, i) => [Date.parse(addDays('2026-08-01', i)) / 1000, value]);

    /** Sixty more days of chain history than the default harness, with 10 tokens (100 USD) burned at noon on every day of August. */
    const longHarness = (llamaPerDay: number) => {
      const h = harness(testDb(), {
        routes: {
          [LLAMA]: { totalDataChart: [...august(llamaPerDay), [Date.parse('2026-09-01') / 1000, 1]] },
          [CG_CHART]: hourlyPrices('2026-07-01T00:00:00Z', '2026-09-19T12:00:00Z', () => 10),
        },
      });
      const genesis = GENESIS_TS - 60 * 86_400;
      const blockAtNoon = (day: string) => BigInt(Math.ceil((Date.parse(`${day}T12:00:00Z`) / 1000 - genesis) / 2));
      const logs = Array.from({ length: 31 }, (_, i) => ({
        blockNumber: blockAtNoon(addDays('2026-08-01', i)), logIndex: 0, txHash: `0xaug${i}`, from: POOL, value: 10n * E18,
      }));
      const rpc = fakeRpc({ genesisTs: genesis, latest: BigInt(Math.floor((h.deps.now().getTime() / 1000 - genesis) / 2)), calls: defaultCalls(), logs });
      const deps: FetchDeps = { ...h.deps, rpcFactory: () => rpc };
      return { h, deps };
    };

    it('compares completed months and stays quiet within tolerance', async () => {
      const { h, deps } = longHarness(103);
      const r = await fetchAsset(h.db, h.loaded, h.deps.now(), deps, { backfillDays: 50 });
      expect(source(r, LLAMA_ID).crossChecks).toEqual([
        { metricKey: 'flow_usd.fees', sourceId: LLAMA_ID, label: '2026-08', primary: 3100, check: 3193, diffPct: expect.closeTo(3, 9), tolerancePct: 5, ok: true },
      ]);
      expect(r.anomalies).toEqual([]);
    });

    it('raises one anomaly listing the months that are out of tolerance, from a dry run too', async () => {
      const { h, deps } = longHarness(120);
      const r = await fetchAsset(h.db, h.loaded, h.deps.now(), deps, { backfillDays: 50, dryRun: true });
      expect(r.anomalies).toHaveLength(1);
      expect(r.anomalies[0]).toMatchObject({ kind: 'cross_check_mismatch', metricKey: 'flow_usd.fees', dedupeKey: LLAMA_ID, severity: 'degrading', id: null });
      expect(r.anomalies[0].detail).toMatchObject({ tolerance_pct: 5, check_source: LLAMA_ID, months: [{ month: '2026-08', primary: 3100, check: 3720 }] });
    });
  });

  it('notes when no month is covered by both series yet', async () => {
    const h = harness(testDb());
    const r = await fetchAsset(h.db, h.loaded, h.deps.now(), h.deps);
    expect(source(r, LLAMA_ID)).toMatchObject({ status: 'ok', crossChecks: [] });
    expect(source(r, LLAMA_ID).notes).toEqual(['flow_usd.fees: no calendar month is fully covered by both series yet']);
  });
});
