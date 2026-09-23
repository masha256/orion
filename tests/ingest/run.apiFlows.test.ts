import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseAssetYaml } from '../../src/config/load.js';
import { getCursor } from '../../src/db/fetchCursors.js';
import { insertObservation, listActiveObservations, listObservations } from '../../src/db/observations.js';
import { REVISION_DAYS } from '../../src/ingest/apiFlow.js';
import { fetchAsset, type FetchResult } from '../../src/ingest/run.js';
import { harness, type Harness } from '../helpers/fetchHarness.js';

const LLAMA_HYPE = 'https://api.llama.fi/summary/fees/hyperliquid';
const SOURCE = 'defillama:hyperliquid:dailyHoldersRevenue';
const METRIC = 'flow_usd.buyback';
const unix = (day: string) => Date.parse(`${day}T00:00:00Z`) / 1000;
const chart = (points: Record<string, number>) => ({ totalDataChart: Object.entries(points).map(([d, v]) => [unix(d), v]) });
/** NOW is 2026-09-19T12:00Z, so 2026-09-18 is the last complete day. 09-16 is not aggregated yet; 09-19 is today and never written. */
const SERIES = { '2026-09-14': 100, '2026-09-15': 110, '2026-09-17': 130, '2026-09-18': 140, '2026-09-19': 999 };

/** The HYPE fixture: a non-EVM asset whose only source is its buyback flow on DefiLlama. */
function world(points: Record<string, number>, over: Parameters<typeof harness>[0] = {}): Harness {
  const loaded = parseAssetYaml(readFileSync(fileURLToPath(new URL('../fixtures/hype.yaml', import.meta.url)), 'utf8'));
  return harness({ loaded, routes: { [LLAMA_HYPE]: chart(points) }, ...over });
}
const fetch = (h: Harness, opts: Parameters<typeof fetchAsset>[4] = {}) => fetchAsset(h.db, h.loaded, h.deps.now(), h.deps, opts);
const source = (r: FetchResult) => r.sources.find((s) => s.sourceId === SOURCE)!;
const byDay = (h: Harness) => Object.fromEntries(listActiveObservations(h.db, 'hype', METRIC).map((o) => [o.observedAt.slice(0, 10), o.value]));

describe('fetchAsset: a flow whose primary is a DefiLlama daily series', () => {
  it('writes one row per completed day the series has, skips a day it lacks, touches no chain, and sets the cursor', async () => {
    const h = world(SERIES);
    const r = await fetch(h);
    expect(r.outcome).toBe('ok');
    expect(r.sources.map((s) => s.sourceId)).toEqual([SOURCE]); // no chain_levels, no transfer scan
    expect(source(r)).toMatchObject({ status: 'ok', metricsWritten: [METRIC], conflicts: [], retiredObservationIds: [] });
    expect(source(r).notes.join('\n')).toMatch(/not in the series, skipped: 86 days from 2026-06-21 to 2026-09-16/); // the 90-day backfill reaches back before the series starts
    // Rows are the transfer scan's shape: period 1, observed at the end of the day, source api, the URL as detail.
    expect(byDay(h)).toEqual({ '2026-09-15': 100, '2026-09-16': 110, '2026-09-18': 130, '2026-09-19': 140 });
    expect(listActiveObservations(h.db, 'hype', METRIC)[0]).toMatchObject({ periodDays: 1, source: 'api', status: 'confirmed', sourceDetail: `${LLAMA_HYPE}?dataType=dailyHoldersRevenue` });
    expect(r.written.map((w) => w.observedAt.slice(0, 10))).toEqual(['2026-09-15', '2026-09-16', '2026-09-18', '2026-09-19']);
    expect(getCursor(h.db, 'hype', `${SOURCE}>${METRIC}`)).toEqual({ lastBlock: 0, lastDay: '2026-09-18' });
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
    expect(byDay(h)).toEqual({ '2026-09-15': 100, '2026-09-16': 110, '2026-09-17': 120, '2026-09-18': 135, '2026-09-19': 140 });
    const history = listObservations(h.db, 'hype', METRIC, { includeInactive: true }).filter((o) => o.observedAt.startsWith('2026-09-18'));
    expect(history.map((o) => [o.value, o.supersededBy !== null])).toEqual([[135, false], [130, true]]);
  });

  it(`re-reads only the last ${REVISION_DAYS} written days: an older revision waits for --backfill-days, which rewrites only what changed`, async () => {
    const h = world(SERIES);
    await fetch(h);
    const old = await fetch(world({ ...SERIES, '2026-09-14': 101 }, { db: h.db }));
    expect(old.written).toEqual([]);
    expect(byDay(h)['2026-09-15']).toBe(100);
    const rescan = await fetch(world({ ...SERIES, '2026-09-14': 101 }, { db: h.db }), { backfillDays: 10 });
    expect(rescan.written.map((w) => [w.observedAt.slice(0, 10), w.value])).toEqual([['2026-09-15', 101]]);
    expect(getCursor(h.db, 'hype', `${SOURCE}>${METRIC}`)!.lastDay).toBe('2026-09-18'); // never moves backwards
  });

  it('refuses to write over a manual row without --adopt, writes nothing on a dry run, and retires it with --adopt', async () => {
    const h = world(SERIES);
    const manual = insertObservation(h.db, { assetId: 'hype', metricKey: METRIC, observedAt: '2026-09-18', periodDays: 7, value: 5000, source: 'manual', fetchedAt: '2026-09-18T00:00:00Z' });
    const refused = await fetch(h);
    expect(source(refused)).toMatchObject({ status: 'skipped', metricsWritten: [], conflicts: [{ observationId: manual.id, adoptable: true }] });
    expect(source(refused).notes.join('\n')).toMatch(/Re-run with --adopt/);
    expect(refused.outcome).toBe('partial');
    expect(listActiveObservations(h.db, 'hype', METRIC)).toHaveLength(1);

    const dry = await fetch(h, { adopt: true, dryRun: true });
    expect(dry.written.map((w) => w.observationId)).toEqual([null, null, null, null]);
    expect(source(dry).notes.join('\n')).toMatch(new RegExp(`--adopt would reject #${manual.id}`));
    expect(listActiveObservations(h.db, 'hype', METRIC)).toHaveLength(1);
    expect(getCursor(h.db, 'hype', `${SOURCE}>${METRIC}`)).toBeNull();

    const adopted = await fetch(h, { adopt: true });
    expect(source(adopted)).toMatchObject({ status: 'ok', retiredObservationIds: [manual.id] });
    expect(byDay(h)).toEqual({ '2026-09-15': 100, '2026-09-16': 110, '2026-09-18': 130, '2026-09-19': 140 });
  });

  it('fails the source on a value the metric cannot store, and writes none of the days', async () => {
    const h = world({ ...SERIES, '2026-09-15': -5 });
    const r = await fetch(h);
    expect(source(r)).toMatchObject({ status: 'failed', metricsWritten: [] });
    expect(source(r).error).toMatch(/2026-09-15: -5 is negative/);
    expect(listActiveObservations(h.db, 'hype', METRIC)).toEqual([]);
    expect(getCursor(h.db, 'hype', `${SOURCE}>${METRIC}`)).toBeNull();
  });

  it('--adopt retires a manual row that overlaps only unchanged days, so nothing is counted twice', async () => {
    const h = world(SERIES);
    await fetch(h);
    const manual = insertObservation(h.db, { assetId: 'hype', metricKey: METRIC, observedAt: '2026-09-18T06:00:00Z', periodDays: 1, value: 777, source: 'manual', fetchedAt: '2026-09-18T06:00:00Z' });
    const refused = await fetch(h);
    expect(source(refused)).toMatchObject({ status: 'skipped', metricsWritten: [] });
    const adopted = await fetch(h, { adopt: true });
    expect(source(adopted)).toMatchObject({ status: 'ok', retiredObservationIds: [manual.id] });
    expect(listActiveObservations(h.db, 'hype', METRIC).some((o) => o.source === 'manual')).toBe(false);
    const plain = await fetch(h);
    expect(source(plain)).toMatchObject({ status: 'ok' });
  });

  it('reports no retirement when the transaction rolled back', async () => {
    const h = world({ ...SERIES, '2026-09-18': -5 });
    const manual = insertObservation(h.db, { assetId: 'hype', metricKey: METRIC, observedAt: '2026-09-15', periodDays: 1, value: 5000, source: 'manual', fetchedAt: '2026-09-15T00:00:00Z' });
    const r = await fetch(h, { adopt: true });
    expect(source(r)).toMatchObject({ status: 'failed', retiredObservationIds: [] });
    expect(listActiveObservations(h.db, 'hype', METRIC)).toHaveLength(1);
  });

  it('picks up a day that appeared later than the revision window', async () => {
    const h = world({ '2026-09-14': 100, '2026-09-15': 110, '2026-09-17': 130, '2026-09-18': 140 });
    await fetch(h);
    const later = new Date('2026-09-22T12:00:00.000Z');
    const r2 = await fetch(world({ '2026-09-14': 100, '2026-09-15': 110, '2026-09-17': 130, '2026-09-18': 140, '2026-09-19': 150, '2026-09-20': 160, '2026-09-21': 170 }, { db: h.db, now: later }));
    expect(r2.written.map((w) => w.observedAt.slice(0, 10))).toEqual(['2026-09-20', '2026-09-21', '2026-09-22']);
    expect(getCursor(h.db, 'hype', `${SOURCE}>${METRIC}`)!.lastDay).toBe('2026-09-21');
    expect(source(r2).notes.join('\n')).toMatch(/skipped: 2026-09-16/);
    const r3 = await fetch(world({ '2026-09-14': 100, '2026-09-15': 110, '2026-09-16': 120, '2026-09-17': 130, '2026-09-18': 140, '2026-09-19': 150, '2026-09-20': 160, '2026-09-21': 170 }, { db: h.db, now: later }));
    expect(r3.written.map((w) => [w.observedAt.slice(0, 10), w.value])).toEqual([['2026-09-17', 120]]);
    expect(byDay(h)['2026-09-17']).toBe(120);
  });

  it('an old gap does not widen the revision window: a revision behind it is not taken', async () => {
    const A = { '2026-09-10': 10, '2026-09-11': 11, '2026-09-13': 13, '2026-09-14': 14, '2026-09-15': 15, '2026-09-16': 16, '2026-09-17': 17, '2026-09-18': 18 };
    const h = world(A);
    await fetch(h);
    const r = await fetch(world({ ...A, '2026-09-13': 999 }, { db: h.db }));
    expect(r.written).toEqual([]);
    expect(byDay(h)['2026-09-14']).toBe(13);
    expect(source(r).notes.join('\n')).toMatch(/skipped: 2026-09-12/);
    expect(source(r).notes.join('\n')).toMatch(/1 gap day\(s\) still missing/);
    const r2 = await fetch(world({ ...A, '2026-09-13': 999, '2026-09-17': 170 }, { db: h.db }));
    expect(r2.written.map((w) => [w.observedAt.slice(0, 10), w.value])).toEqual([['2026-09-18', 170]]);
    expect(byDay(h)['2026-09-14']).toBe(13);
  });

  it('a manual row filling a day the series never reports is neither a conflict nor a gap', async () => {
    const A = { '2026-09-10': 10, '2026-09-11': 11, '2026-09-13': 13, '2026-09-14': 14, '2026-09-15': 15, '2026-09-16': 16, '2026-09-17': 17, '2026-09-18': 18 };
    const h = world(A);
    await fetch(h);
    const fill = insertObservation(h.db, { assetId: 'hype', metricKey: METRIC, observedAt: '2026-09-13T00:00:00Z', periodDays: 1, value: 12, source: 'manual', fetchedAt: '2026-09-19T00:00:00Z' });
    const r = await fetch(h);
    expect(source(r)).toMatchObject({ status: 'ok', conflicts: [], retiredObservationIds: [] });
    expect(source(r).notes.join('\n')).not.toMatch(/skipped/);
    expect(listActiveObservations(h.db, 'hype', METRIC).find((o) => o.id === fill.id)).toBeDefined();
    const adopted = await fetch(h, { adopt: true });
    expect(source(adopted).retiredObservationIds).toEqual([]);
    expect(listActiveObservations(h.db, 'hype', METRIC).find((o) => o.id === fill.id)).toBeDefined();
  });
});
