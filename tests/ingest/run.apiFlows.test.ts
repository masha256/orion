import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseAssetYaml } from '../../src/config/load.js';
import type { Db } from '../../src/db/connection.js';
import { listAnomalies } from '../../src/db/anomalies.js';
import { getCursor } from '../../src/db/fetchCursors.js';
import { insertObservation, listActiveObservations, listObservations } from '../../src/db/observations.js';
import { DEFILLAMA_REVISION_DAYS, REVISION_DAYS } from '../../src/ingest/apiFlow.js';
import { registerAdapter } from '../../src/ingest/adapters/registry.js';
import { fetchAsset, type FetchResult } from '../../src/ingest/run.js';
import type { AdapterWarning, DailyPoint, SourceContext } from '../../src/ingest/types.js';
import { ADAPTER_SOURCE_TYPES, type SourceType } from '../../src/report/sourceTypes.js';
import { harness, type Harness } from '../helpers/fetchHarness.js';
import { useTestDb } from '../helpers/db.js';
import { TEST_PROVENANCE, testProvenance } from '../helpers/provenance.js';

const testDb = useTestDb();

const LLAMA_HYPE = 'https://api.llama.fi/summary/fees/hyperliquid';
const SOURCE = 'defillama:hyperliquid:dailyHoldersRevenue';
const METRIC = 'flow_usd.buyback';
const unix = (day: string) => Date.parse(`${day}T00:00:00Z`) / 1000;
const chart = (points: Record<string, number>) => ({ totalDataChart: Object.entries(points).map(([d, v]) => [unix(d), v]) });
/** NOW is 2026-09-19T12:00Z, so 2026-09-18 is the last complete day. 09-16 is not aggregated yet; 09-19 is today and never written. */
const SERIES = { '2026-09-14': 100, '2026-09-15': 110, '2026-09-17': 130, '2026-09-18': 140, '2026-09-19': 999 };

/**
 * The HYPE fixture: a non-EVM asset whose only source is its buyback flow on DefiLlama. These tests pin the window
 * mechanics on a short window (revision_days: REVISION_DAYS); a DefiLlama source without it reads 30 days back.
 */
const FIXTURE = readFileSync(fileURLToPath(new URL('../fixtures/hype.yaml', import.meta.url)), 'utf8');
function world(points: Record<string, number>, { db = testDb(), ...over }: Parameters<typeof harness>[1] & { db?: Db } = {}, revisionDays: number | null = REVISION_DAYS): Harness {
  const yaml = revisionDays === null ? FIXTURE : FIXTURE.replace('data_type: dailyHoldersRevenue }', `data_type: dailyHoldersRevenue, revision_days: ${revisionDays} }`);
  if (revisionDays !== null && yaml === FIXTURE) throw new Error('the fixture no longer has the DefiLlama source this test edits');
  return harness(db, { loaded: parseAssetYaml(yaml), routes: { [LLAMA_HYPE]: chart(points) }, ...over });
}
const fetch = (h: Harness, opts: Parameters<typeof fetchAsset>[4] = {}) => fetchAsset(h.db, h.loaded, h.deps.now(), h.deps, opts);
const source = (r: FetchResult) => r.sources.find((s) => s.sourceId === SOURCE)!;
const byDay = async (h: Harness) => Object.fromEntries((await listActiveObservations(h.db, 'hype', METRIC)).map((o) => [o.observedAt.slice(0, 10), o.value]));

describe('fetchAsset: a flow whose primary is a DefiLlama daily series', () => {
  it('writes one row per completed day the series has, skips a day it lacks, touches no chain, and sets the cursor', async () => {
    const h = world(SERIES);
    const r = await fetch(h);
    expect(r.outcome).toBe('ok');
    expect(r.sources.map((s) => s.sourceId)).toEqual([SOURCE]); // no chain_levels, no transfer scan
    expect(source(r)).toMatchObject({ status: 'ok', metricsWritten: [METRIC], conflicts: [], retiredObservationIds: [] });
    expect(source(r).notes.join('\n')).toMatch(/not in the series, skipped: 86 days from 2026-06-21 to 2026-09-16/); // the 90-day backfill reaches back before the series starts
    // Rows are the transfer scan's shape: period 1, observed at the end of the day, source api, the URL as detail.
    expect(await byDay(h)).toEqual({ '2026-09-15': 100, '2026-09-16': 110, '2026-09-18': 130, '2026-09-19': 140 });
    expect((await listActiveObservations(h.db, 'hype', METRIC))[0]).toMatchObject({ periodDays: 1, source: 'api', status: 'confirmed', sourceDetail: `${LLAMA_HYPE}?dataType=dailyHoldersRevenue` });
    expect(r.written.map((w) => w.observedAt.slice(0, 10))).toEqual(['2026-09-15', '2026-09-16', '2026-09-18', '2026-09-19']);
    expect(await getCursor(h.db, 'hype', `${SOURCE}>${METRIC}`)).toEqual({ lastBlock: 0, lastDay: '2026-09-18' });
  });

  it('writes nothing new the next day, supersedes a day the source revised, and picks up a day that appeared late', async () => {
    const h = world(SERIES);
    await fetch(h);
    const same = await fetch(world(SERIES, { db: h.db }));
    expect(same.written).toEqual([]);
    expect(source(same)).toMatchObject({ status: 'ok', metricsWritten: [] });
    expect(source(same).notes.join('\n')).toMatch(/no new or revised day in 2026-09-16 to 2026-09-18/);

    const revised = await fetch(world({ ...SERIES, '2026-09-16': 120, '2026-09-17': 135 }, { db: h.db }));
    expect(revised.written.map((w) => [w.observedAt.slice(0, 10), w.value])).toEqual([['2026-09-17', 120], ['2026-09-18', 135]]);
    expect(source(revised).notes.join('\n')).toMatch(/revised by the source, superseded: 2026-09-17/);
    expect(await byDay(h)).toEqual({ '2026-09-15': 100, '2026-09-16': 110, '2026-09-17': 120, '2026-09-18': 135, '2026-09-19': 140 });
    const history = (await listObservations(h.db, 'hype', METRIC, { includeInactive: true })).filter((o) => o.observedAt.startsWith('2026-09-18'));
    expect(history.map((o) => [o.value, o.supersededBy !== null])).toEqual([[135, false], [130, true]]);
  });

  it(`re-reads only the last ${REVISION_DAYS} written days: an older revision waits for --backfill-days, which rewrites only what changed`, async () => {
    const h = world(SERIES);
    await fetch(h);
    const old = await fetch(world({ ...SERIES, '2026-09-14': 101 }, { db: h.db }));
    expect(old.written).toEqual([]);
    expect((await byDay(h))['2026-09-15']).toBe(100);
    const rescan = await fetch(world({ ...SERIES, '2026-09-14': 101 }, { db: h.db }), { backfillDays: 10 });
    expect(rescan.written.map((w) => [w.observedAt.slice(0, 10), w.value])).toEqual([['2026-09-15', 101]]);
    expect((await getCursor(h.db, 'hype', `${SOURCE}>${METRIC}`))!.lastDay).toBe('2026-09-18'); // never moves backwards
  });

  it('refuses to write over a manual row without --adopt, writes nothing on a dry run, and retires it with --adopt', async () => {
    const h = world(SERIES);
    const manual = await insertObservation(h.db, { provenance: testProvenance('manual'), assetId: 'hype', metricKey: METRIC, observedAt: '2026-09-18', periodDays: 7, value: 5000, fetchedAt: '2026-09-18T00:00:00Z' });
    const refused = await fetch(h);
    expect(source(refused)).toMatchObject({ status: 'skipped', metricsWritten: [], conflicts: [{ observationId: manual.id, adoptable: true }] });
    expect(source(refused).notes.join('\n')).toMatch(/Re-run with --adopt/);
    expect(refused.outcome).toBe('partial');
    expect(await listActiveObservations(h.db, 'hype', METRIC)).toHaveLength(1);

    const dry = await fetch(h, { adopt: true, dryRun: true });
    expect(dry.written.map((w) => w.observationId)).toEqual([null, null, null, null]);
    expect(source(dry).notes.join('\n')).toMatch(new RegExp(`--adopt would reject #${manual.id}`));
    expect(await listActiveObservations(h.db, 'hype', METRIC)).toHaveLength(1);
    expect(await getCursor(h.db, 'hype', `${SOURCE}>${METRIC}`)).toBeNull();

    const adopted = await fetch(h, { adopt: true });
    expect(source(adopted)).toMatchObject({ status: 'ok', retiredObservationIds: [manual.id] });
    expect(await byDay(h)).toEqual({ '2026-09-15': 100, '2026-09-16': 110, '2026-09-18': 130, '2026-09-19': 140 });
  });

  it('fails the source on a value the metric cannot store, and writes none of the days', async () => {
    const h = world({ ...SERIES, '2026-09-15': -5 });
    const r = await fetch(h);
    expect(source(r)).toMatchObject({ status: 'failed', metricsWritten: [] });
    expect(source(r).error).toMatch(/2026-09-15: -5 is negative/);
    expect(await listActiveObservations(h.db, 'hype', METRIC)).toEqual([]);
    expect(await getCursor(h.db, 'hype', `${SOURCE}>${METRIC}`)).toBeNull();
  });

  it('--adopt retires a manual row that overlaps only unchanged days, so nothing is counted twice', async () => {
    const h = world(SERIES);
    await fetch(h);
    const manual = await insertObservation(h.db, { provenance: testProvenance('manual'), assetId: 'hype', metricKey: METRIC, observedAt: '2026-09-18T06:00:00Z', periodDays: 1, value: 777, fetchedAt: '2026-09-18T06:00:00Z' });
    // A routine run leaves a manual row in the revision window alone (a decision already taken), days it covers included.
    const routine = await fetch(h);
    expect(source(routine)).toMatchObject({ status: 'ok', conflicts: [] });
    expect(source(routine).notes.join('\n')).toMatch(new RegExp(`left as entered by hand: 2026-09-17, 2026-09-18 \\(#${manual.id}\\)`));
    expect((await listActiveObservations(h.db, 'hype', METRIC)).find((o) => o.id === manual.id)).toBeDefined();
    // A rescan still refuses it.
    const refused = await fetch(h, { backfillDays: 10 });
    expect(source(refused)).toMatchObject({ status: 'skipped', metricsWritten: [] });
    const adopted = await fetch(h, { adopt: true });
    expect(source(adopted)).toMatchObject({ status: 'ok', retiredObservationIds: [manual.id] });
    expect((await listActiveObservations(h.db, 'hype', METRIC)).some((o) => o.source === 'manual')).toBe(false);
    const plain = await fetch(h);
    expect(source(plain)).toMatchObject({ status: 'ok' });
  });

  it('reports no retirement when the transaction rolled back', async () => {
    const h = world({ ...SERIES, '2026-09-18': -5 });
    const manual = await insertObservation(h.db, { provenance: testProvenance('manual'), assetId: 'hype', metricKey: METRIC, observedAt: '2026-09-15', periodDays: 1, value: 5000, fetchedAt: '2026-09-15T00:00:00Z' });
    const r = await fetch(h, { adopt: true });
    expect(source(r)).toMatchObject({ status: 'failed', retiredObservationIds: [] });
    expect(await listActiveObservations(h.db, 'hype', METRIC)).toHaveLength(1);
  });

  it('picks up a day that appeared later than the revision window', async () => {
    const h = world({ '2026-09-14': 100, '2026-09-15': 110, '2026-09-17': 130, '2026-09-18': 140 });
    await fetch(h);
    const later = new Date('2026-09-22T12:00:00.000Z');
    const r2 = await fetch(world({ '2026-09-14': 100, '2026-09-15': 110, '2026-09-17': 130, '2026-09-18': 140, '2026-09-19': 150, '2026-09-20': 160, '2026-09-21': 170 }, { db: h.db, now: later }));
    expect(r2.written.map((w) => w.observedAt.slice(0, 10))).toEqual(['2026-09-20', '2026-09-21', '2026-09-22']);
    expect((await getCursor(h.db, 'hype', `${SOURCE}>${METRIC}`))!.lastDay).toBe('2026-09-21');
    expect(source(r2).notes.join('\n')).toMatch(/skipped: 2026-09-16/);
    const r3 = await fetch(world({ '2026-09-14': 100, '2026-09-15': 110, '2026-09-16': 120, '2026-09-17': 130, '2026-09-18': 140, '2026-09-19': 150, '2026-09-20': 160, '2026-09-21': 170 }, { db: h.db, now: later }));
    expect(r3.written.map((w) => [w.observedAt.slice(0, 10), w.value])).toEqual([['2026-09-17', 120]]);
    expect((await byDay(h))['2026-09-17']).toBe(120);
  });

  it('an old gap does not widen the revision window: a revision behind it is not taken', async () => {
    const A = { '2026-09-10': 10, '2026-09-11': 11, '2026-09-13': 13, '2026-09-14': 14, '2026-09-15': 15, '2026-09-16': 16, '2026-09-17': 17, '2026-09-18': 18 };
    const h = world(A);
    await fetch(h);
    const r = await fetch(world({ ...A, '2026-09-13': 999 }, { db: h.db }));
    expect(r.written).toEqual([]);
    expect((await byDay(h))['2026-09-14']).toBe(13);
    expect(source(r).notes.join('\n')).toMatch(/skipped: 2026-09-12/);
    expect(source(r).notes.join('\n')).toMatch(/1 gap day\(s\) still missing/);
    const r2 = await fetch(world({ ...A, '2026-09-13': 999, '2026-09-17': 170 }, { db: h.db }));
    expect(r2.written.map((w) => [w.observedAt.slice(0, 10), w.value])).toEqual([['2026-09-18', 170]]);
    expect((await byDay(h))['2026-09-14']).toBe(13);
  });

  it('a manual row filling a day the series never reports is neither a conflict nor a gap', async () => {
    const A = { '2026-09-10': 10, '2026-09-11': 11, '2026-09-13': 13, '2026-09-14': 14, '2026-09-15': 15, '2026-09-16': 16, '2026-09-17': 17, '2026-09-18': 18 };
    const h = world(A);
    await fetch(h);
    const fill = await insertObservation(h.db, { provenance: testProvenance('manual'), assetId: 'hype', metricKey: METRIC, observedAt: '2026-09-13T00:00:00Z', periodDays: 1, value: 12, fetchedAt: '2026-09-19T00:00:00Z' });
    const r = await fetch(h);
    expect(source(r)).toMatchObject({ status: 'ok', conflicts: [], retiredObservationIds: [] });
    expect(source(r).notes.join('\n')).not.toMatch(/skipped/);
    expect((await listActiveObservations(h.db, 'hype', METRIC)).find((o) => o.id === fill.id)).toBeDefined();
    const adopted = await fetch(h, { adopt: true });
    expect(source(adopted).retiredObservationIds).toEqual([]);
    expect((await listActiveObservations(h.db, 'hype', METRIC)).find((o) => o.id === fill.id)).toBeDefined();
  });

  it('skips an unstorable value on a gap day instead of failing every run', async () => {
    const S = { '2026-09-14': -5, '2026-09-15': 110, '2026-09-17': 130, '2026-09-18': 140, '2026-09-19': 999 };
    const h = world(S);
    const first = await fetch(h, { backfillDays: 3 }); // reads 09-16..09-18: 09-16 is absent, so 09-17 and 09-18 are written
    expect(source(first)).toMatchObject({ status: 'ok' });
    const afterFirst = await byDay(h);
    expect(afterFirst).toEqual({ '2026-09-18': 130, '2026-09-19': 140 });
    expect((await getCursor(h.db, 'hype', `${SOURCE}>${METRIC}`))!.lastDay).toBe('2026-09-18');
    // The 90-day window makes 09-14 and 09-15 gap days: 09-14 cannot be stored and stays a gap, 09-15 is taken.
    for (let run = 0; run < 2; run++) {
      const r = await fetch(world(S, { db: h.db }));
      expect(source(r).status).toBe('ok');
      expect(source(r).notes.join('\n')).toMatch(/not storable, skipped \(still a gap\): 2026-09-14: -5 is negative/);
      expect(await byDay(h)).toEqual({ ...afterFirst, '2026-09-16': 110 });
    }
  });

  it('a manual row not at midnight covers both days it touches', async () => {
    const A = { '2026-09-10': 10, '2026-09-11': 11, '2026-09-13': 13, '2026-09-14': 14, '2026-09-15': 15, '2026-09-16': 16, '2026-09-17': 17, '2026-09-18': 18 };
    const h = world(A);
    await fetch(h);
    // Covers 09-11T12:00 to 09-12T12:00: half of 09-11 and half of 09-12, both before the revision range 09-16..09-18.
    const manual = await insertObservation(h.db, { provenance: testProvenance('manual'), assetId: 'hype', metricKey: METRIC, observedAt: '2026-09-12T12:00:00Z', periodDays: 1, value: 777, fetchedAt: '2026-09-19T00:00:00Z' });
    const r = await fetch(world({ ...A, '2026-09-12': 12 }, { db: h.db }));
    expect(source(r)).toMatchObject({ status: 'ok', conflicts: [], retiredObservationIds: [] });
    expect(r.written).toEqual([]);
    expect((await byDay(h))['2026-09-13']).toBeUndefined(); // the day 09-12 is not written beside the manual row
    expect((await listActiveObservations(h.db, 'hype', METRIC)).find((o) => o.id === manual.id)).toBeDefined();
  });

  it('fails the source on an empty series', async () => {
    const h = world({});
    const r = await fetch(h);
    expect(source(r).status).toBe('failed');
    expect(source(r).error).toMatch(/no days/);
  });
});

describe('fetchAsset: a DefiLlama series is read again 30 days back on every run (Mike, 2026-10-12)', () => {
  const NOW = new Date('2026-10-12T12:00:00.000Z');
  const days = (from: string, n: number, v: (i: number) => number) =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10), v(i)]));
  const BASE = days('2026-08-01', 72, (i) => 100 + i); // 2026-08-01 .. 2026-10-11

  it(`supersedes a day the source revised ${DEFILLAMA_REVISION_DAYS - 1} days back, and leaves one ${DEFILLAMA_REVISION_DAYS + 1} days back for --backfill-days`, async () => {
    expect(DEFILLAMA_REVISION_DAYS).toBe(30);
    const h = world(BASE, { now: NOW }, null);
    await fetch(h);
    // The cursor is 2026-10-11: the window is 2026-09-12 .. 2026-10-11.
    const revised = await fetch(world({ ...BASE, '2026-09-12': 5000, '2026-09-11': 6000 }, { db: h.db, now: NOW }, null));
    expect(revised.written.map((w) => [w.observedAt.slice(0, 10), w.value])).toEqual([['2026-09-13', 5000]]);
    expect(source(revised).notes.join('\n')).toMatch(/revised by the source, superseded: 2026-09-12/);
    expect((await byDay(h))['2026-09-12']).toBe(BASE['2026-09-11']); // outside the window: unchanged
  });

  it.each([['a correction (R17 2a shape)', false], ['a cited disclosure (data set)', true]] as const)('leaves a manual row inside the 30 days alone and writes every other revised day: %s', async (_shape, cited) => {
    const h = world(BASE, { now: NOW }, null);
    await fetch(h);
    const manual = await insertObservation(h.db, { ...(cited ? { citationUrl: 'https://example.test/c' } : {}), provenance: testProvenance('manual', cited), assetId: 'hype', metricKey: METRIC, observedAt: '2026-09-10T00:00:00Z', periodDays: 1, value: 1, fetchedAt: '2026-09-24T00:00:00Z' });
    // The source still has its artifact on 09-09 (outside) and revises 09-20 (inside); a 09-15 manual row is inside.
    const fix = await insertObservation(h.db, { ...(cited ? { citationUrl: 'https://example.test/c' } : {}), provenance: testProvenance('manual', cited), assetId: 'hype', metricKey: METRIC, observedAt: '2026-09-16T00:00:00Z', periodDays: 1, value: 2, fetchedAt: '2026-09-24T00:00:00Z' });
    const r = await fetch(world({ ...BASE, '2026-09-15': 9999, '2026-09-20': 7777 }, { db: h.db, now: NOW }, null));
    expect(source(r)).toMatchObject({ status: 'ok', conflicts: [] });
    expect(r.written.map((w) => [w.observedAt.slice(0, 10), w.value])).toEqual([['2026-09-21', 7777]]);
    expect((await byDay(h))['2026-09-16']).toBe(2);
    expect((await listActiveObservations(h.db, 'hype', METRIC)).filter((o) => o.source === 'manual').map((o) => o.id).sort()).toEqual([manual.id, fix.id].sort());
  });
});


/**
 * Phase 3 R4 Task 2: a daily series an adapter on the pool_scan rung returns. Its rows read back `onchain` (originOf), so
 * the series writer must stamp, look up and conflict-check by that origin, not by the API stamp every earlier adapter
 * series carries. The adapter is registered for this file only (vitest isolates files), in a beforeAll.
 */
describe('fetchAsset: an adapter series on the pool_scan rung (Phase 3 R4)', () => {
  const NAME = 'test.pool_scan_daily';
  const POOL_SOURCE = `adapter:${NAME}`;
  const state: { points: DailyPoint[]; warnings?: AdapterWarning[]; storedSeen: Set<string>[] } = { points: [], storedSeen: [] };
  beforeAll(() => {
    (ADAPTER_SOURCE_TYPES as Record<string, SourceType>)[NAME] = 'pool_scan';
    registerAdapter({
      name: NAME,
      needsRpc: false,
      run: async (ctx: SourceContext) => {
        if (ctx.storedFlowDays) state.storedSeen.push(await ctx.storedFlowDays(METRIC));
        return { kind: 'daily_series', points: state.points, detail: 'pool scan (test)', ...(state.warnings ? { warnings: state.warnings } : {}) };
      },
    });
  });
  afterAll(() => {
    delete (ADAPTER_SOURCE_TYPES as Record<string, SourceType>)[NAME];
  });
  const POOL_YAML = FIXTURE
    .replace('source: { type: defillama, slug: hyperliquid, data_type: dailyHoldersRevenue }', `source: { type: adapter, name: ${NAME}, params: {} }`)
    .replace('revenue_run_rate_usd: { type: level, unit: usd, staleness_days: 7, critical: true }', 'revenue_run_rate_usd: { type: level, unit: usd, staleness_days: 7, critical: true, source: { type: derived, name: flow_annualized, params: { metric: flow_usd.buyback, days: 2 } } }');
  const pool = (points: Record<string, number>, db: Db = testDb()): Harness => {
    if (!POOL_YAML.includes(NAME) || !POOL_YAML.includes('flow_annualized')) throw new Error('the fixture no longer has the lines this test edits');
    state.points = Object.entries(points).map(([day, value]) => ({ day, value }));
    return harness(db, { loaded: parseAssetYaml(POOL_YAML) });
  };
  const poolSource = (r: FetchResult) => r.sources.find((s) => s.sourceId === POOL_SOURCE)!;
  const SERIES_DAYS = { '2026-09-14': 100, '2026-09-15': 110, '2026-09-17': 130, '2026-09-18': 140 };

  it('a pool_scan series stamps onchain, reads its own rows back as stored, and does not conflict', async () => {
    const h = pool(SERIES_DAYS);
    const first = await fetch(h);
    expect(poolSource(first)).toMatchObject({ status: 'ok', metricsWritten: [METRIC], conflicts: [] });
    expect(first.written.filter((w) => w.metricKey === METRIC).map((w) => w.source)).toEqual(['onchain', 'onchain', 'onchain', 'onchain']);
    const rows = await listActiveObservations(h.db, 'hype', METRIC);
    expect(rows.map((o) => o.source)).toEqual(['onchain', 'onchain', 'onchain', 'onchain']);
    expect(await h.db.all(`SELECT DISTINCT method, source_type FROM observations WHERE metric_key = '${METRIC}'`)).toEqual([{ method: 'measured', source_type: 'pool_scan' }]);
    // A derivation over an on-chain adapter series is on chain too (run.ts counts an adapter input as api only when its origin is).
    const derived = first.written.filter((w) => w.metricKey === 'revenue_run_rate_usd');
    expect(derived.length).toBeGreaterThan(0);
    expect(derived.every((w) => w.source === 'onchain')).toBe(true);
    expect((await listActiveObservations(h.db, 'hype', 'revenue_run_rate_usd')).every((o) => o.source === 'onchain')).toBe(true);
    expect(await h.db.all("SELECT DISTINCT locator->>'input_origin' AS io FROM observations WHERE metric_key = 'revenue_run_rate_usd'")).toEqual([{ io: null }]);

    const second = await fetch(pool(SERIES_DAYS, h.db));
    expect(poolSource(second)).toMatchObject({ status: 'ok', metricsWritten: [], conflicts: [] });
    expect(second.written.filter((w) => w.metricKey === METRIC)).toEqual([]);
    expect(await byDay(h)).toEqual({ '2026-09-15': 100, '2026-09-16': 110, '2026-09-18': 130, '2026-09-19': 140 });
  });

  it('storedFlowDays returns every day an active row of the metric covers, whatever its source (as the writer does)', async () => {
    const h = pool(SERIES_DAYS);
    state.storedSeen = [];
    await fetch(h);
    expect(state.storedSeen).toEqual([new Set()]); // nothing stored before the first run
    // A row of another origin and a 2-day manual row: the writer treats the days they cover as no gap, so the planner
    // must too (a foreign-row day counted missing would be re-scanned every run and starve the revision days).
    await insertObservation(h.db, { provenance: testProvenance('api'), assetId: 'hype', metricKey: METRIC, observedAt: '2026-09-11T00:00:00.000Z', periodDays: 1, value: 5, fetchedAt: '2026-09-11T00:00:00Z' });
    await insertObservation(h.db, { provenance: testProvenance('manual'), assetId: 'hype', metricKey: METRIC, observedAt: '2026-09-10T00:00:00.000Z', periodDays: 2, value: 9, fetchedAt: '2026-09-10T00:00:00Z' });
    await fetch(pool({ ...SERIES_DAYS, '2026-09-18': 141 }, h.db)); // 09-18 revised: superseded, still one active day
    await fetch(pool(SERIES_DAYS, h.db));
    const own = ['2026-09-14', '2026-09-15', '2026-09-17', '2026-09-18'];
    expect(state.storedSeen[1]).toEqual(new Set([...own, '2026-09-10', '2026-09-08', '2026-09-09']));
    expect(state.storedSeen[2]).toEqual(new Set([...own, '2026-09-10', '2026-09-08', '2026-09-09']));
  });

  it('adapter warnings raise one advisory cross_check_mismatch each, deduped', async () => {
    const h = pool(SERIES_DAYS);
    state.warnings = [
      { dedupeKey: 'pool_scan:drift:8453', detail: { tape: '0xabc' } },
      { dedupeKey: 'pool_scan:coverage:10', detail: { pricedPct: 97.5 } },
      { dedupeKey: 'pool_scan:drift:8453', detail: { tape: '0xabc' } },
    ];
    try {
      const r = await fetch(h);
      expect(r.anomalies.map((a) => [a.kind, a.severity, a.metricKey, a.dedupeKey])).toEqual([
        ['cross_check_mismatch', 'advisory', METRIC, 'pool_scan:drift:8453'],
        ['cross_check_mismatch', 'advisory', METRIC, 'pool_scan:coverage:10'],
      ]);
      expect(r.anomalies[1].detail).toEqual({ pricedPct: 97.5 });
      expect((await listAnomalies(h.db, { assetId: 'hype' })).map((a) => a.dedupeKey).sort()).toEqual(['pool_scan:coverage:10', 'pool_scan:drift:8453']);
      // The rows are still written: a warning never blocks the series.
      expect(poolSource(r)).toMatchObject({ status: 'ok', metricsWritten: [METRIC] });
      // A dry run raises nothing in the database, but reports what it would raise.
      const dry = await fetch(pool(SERIES_DAYS, h.db), { dryRun: true });
      expect(dry.anomalies.map((a) => a.dedupeKey)).toEqual(['pool_scan:drift:8453', 'pool_scan:coverage:10']);
      expect(await listAnomalies(h.db, { assetId: 'hype' })).toHaveLength(2);
    } finally {
      delete state.warnings;
    }
  });
});
