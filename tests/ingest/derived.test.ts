import { describe, expect, it } from 'vitest';
import { parseAssetYaml } from '../../src/config/load.js';
import { insertObservation, listActiveObservations } from '../../src/db/observations.js';
import { checkRevenueStale } from '../../src/ingest/alerts.js';
import { burnMomentum, DERIVED_NAMES, flowAnnualized } from '../../src/ingest/derived.js';
import { buildPlan } from '../../src/ingest/plan.js';
import { fetchAsset } from '../../src/ingest/run.js';
import { addDays } from '../../src/ingest/time.js';
import type { OrionError } from '../../src/types.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { harness, NOW } from '../helpers/fetchHarness.js';
import { INGEST_ASSET_YAML } from '../helpers/ingestAsset.js';

const days = (first: string, values: number[]) => new Map(values.map((v, i) => [addDays(first, i), v] as const));
const iso = (day: string) => `${day}T00:00:00.000Z`;

describe('burnMomentum', () => {
  it('is the mean per day over a full window, for every day that has one', () => {
    expect(burnMomentum(days('2026-09-01', [10, 20, 30, 40]), 3)).toEqual([{ day: '2026-09-03', value: 20 }, { day: '2026-09-04', value: 30 }]);
  });
  it('writes nothing until the window is complete, and nothing across a gap', () => {
    expect(burnMomentum(days('2026-09-01', [10, 20]), 3)).toEqual([]);
    const gapped = days('2026-09-01', [10, 20, 30, 40, 50]);
    gapped.delete('2026-09-03');
    expect(burnMomentum(gapped, 2)).toEqual([{ day: '2026-09-02', value: 15 }, { day: '2026-09-05', value: 45 }]);
  });
  it('counts a zero-burn day as a real reading', () => {
    expect(burnMomentum(days('2026-09-01', [0, 0, 30]), 3)).toEqual([{ day: '2026-09-03', value: 10 }]);
  });
});

describe('flowAnnualized', () => {
  it('is the window sum scaled to a year, for every day that has a complete window', () => {
    // 10 + 20 + 30 = 60 over 3 days: 60 * 365 / 3 = 7300 per year.
    expect(flowAnnualized(days('2026-09-01', [10, 20, 30, 40]), 3)).toEqual([{ day: '2026-09-03', value: 7300 }, { day: '2026-09-04', value: 10950 }]);
  });
  it('writes nothing until the window is complete, and nothing across a gap', () => {
    expect(flowAnnualized(days('2026-09-01', [10, 20]), 3)).toEqual([]);
    const gapped = days('2026-09-01', [10, 20, 30, 40, 50]);
    gapped.delete('2026-09-03');
    expect(flowAnnualized(gapped, 2)).toEqual([{ day: '2026-09-02', value: 5475 }, { day: '2026-09-05', value: 16425 }]);
  });
  it('is a registered derived name', () => {
    expect(DERIVED_NAMES).toEqual(['burn_momentum', 'flow_annualized']);
  });
});

describe('fetchAsset: a revenue run rate derived from an API-series flow', () => {
  const LLAMA_HYPE = 'https://api.llama.fi/summary/fees/hyperliquid';
  const unix = (day: string) => Date.parse(`${day}T00:00:00Z`) / 1000;
  const chart = (points: Record<string, number>) => ({ totalDataChart: Object.entries(points).map(([d, v]) => [unix(d), v]) });
  /** The HYPE fixture with its revenue derived from the buyback flow over 3 days, instead of entered by hand. */
  const yaml = readFileSync(fileURLToPath(new URL('../fixtures/hype.yaml', import.meta.url)), 'utf8').replace(
    'revenue_run_rate_usd: { type: level, unit: usd, staleness_days: 7, critical: true }',
    'revenue_run_rate_usd: { type: level, unit: usd, staleness_days: 7, critical: true, source: { type: derived, name: flow_annualized, params: { metric: flow_usd.buyback, days: 3 } } }',
  );

  it('writes the run rate at each day with a full window, with the api provenance of its input', async () => {
    const h = harness({ loaded: parseAssetYaml(yaml), routes: { [LLAMA_HYPE]: chart({ '2026-09-14': 100, '2026-09-15': 110, '2026-09-16': 120, '2026-09-17': 130, '2026-09-18': 140 }) } });
    const r = await fetchAsset(h.db, h.loaded, NOW, h.deps);
    const rows = listActiveObservations(h.db, 'hype', 'revenue_run_rate_usd');
    expect(rows.map((o) => [o.observedAt.slice(0, 10), o.value])).toEqual([['2026-09-17', (330 * 365) / 3], ['2026-09-18', (360 * 365) / 3], ['2026-09-19', (390 * 365) / 3]]);
    expect(rows[0]).toMatchObject({ source: 'api', periodDays: null, sourceDetail: 'derived flow_annualized(flow_usd.buyback, 3d)' });
    expect(r.sources.find((s) => s.sourceId === 'derived:flow_annualized')).toMatchObject({ status: 'ok', metricsWritten: ['revenue_run_rate_usd'] });
    const again = await fetchAsset(h.db, h.loaded, NOW, h.deps);
    expect(again.sources.find((s) => s.sourceId === 'derived:flow_annualized')!.notes).toEqual(['revenue_run_rate_usd: no new day with 3 complete days behind it']);
  });

  it('reads a manual daily row that replaced a fetched day outside the revision window, so the window stays complete and the run rate moves', async () => {
    const h = harness({ loaded: parseAssetYaml(yaml), routes: { [LLAMA_HYPE]: chart({ '2026-09-11': 100, '2026-09-12': 110, '2026-09-13': 9000, '2026-09-14': 130, '2026-09-15': 140, '2026-09-16': 150, '2026-09-17': 160, '2026-09-18': 170 }) } });
    await fetchAsset(h.db, h.loaded, NOW, h.deps);
    const at = (rows: ReturnType<typeof listActiveObservations>, day: string) => rows.find((o) => o.observedAt.startsWith(day))!.value;
    expect(at(listActiveObservations(h.db, 'hype', 'revenue_run_rate_usd'), '2026-09-14')).toBe((9210 * 365) / 3);
    // The user replaces the 2026-09-13 artifact: a manual row at the day's end supersedes the API row.
    insertObservation(h.db, { assetId: 'hype', metricKey: 'flow_usd.buyback', observedAt: '2026-09-14T00:00:00Z', periodDays: 1, value: 120, source: 'manual', fetchedAt: NOW.toISOString() });
    const r = await fetchAsset(h.db, h.loaded, NOW, h.deps);
    // The day is behind the revision window and covered, so the flow source neither refills it nor refuses it as a conflict.
    expect(r.sources.filter((s) => s.sourceId.startsWith('defillama:'))).toMatchObject([{ status: 'ok', metricsWritten: [], conflicts: [] }]);
    expect(r.sources.find((s) => s.sourceId === 'derived:flow_annualized')).toMatchObject({ status: 'ok', metricsWritten: ['revenue_run_rate_usd'] });
    const rows = listActiveObservations(h.db, 'hype', 'revenue_run_rate_usd');
    expect(at(rows, '2026-09-14')).toBe((330 * 365) / 3); // the windows that cover the replaced day are rewritten
    expect(at(rows, '2026-09-17')).toBe((420 * 365) / 3); // the others are untouched
    expect(rows).toHaveLength(6);
  });
});

describe('checkRevenueStale', () => {
  const index = [
    { observedAt: iso('2026-08-10'), value: 90 },
    { observedAt: iso('2026-08-16'), value: 100 },
    { observedAt: iso('2026-08-20'), value: 105 },
    { observedAt: iso('2026-09-19'), value: 140 },
  ];

  it('compares the latest index with the one nearest the disclosure, within seven days', () => {
    const found = checkRevenueStale(iso('2026-08-17'), index, 30)!;
    expect(found.moveAbsPct).toBeCloseTo(40, 9);
    expect(found.detail).toMatchObject({
      revenue_observed_at: iso('2026-08-17'), basis: 'near_disclosure', threshold_pct: 30,
      index_at_disclosure: { value: 100, observed_at: iso('2026-08-16') }, index_latest: { value: 140, observed_at: iso('2026-09-19') },
    });
    expect((found.detail.move_pct as number)).toBeCloseTo(40, 9);
  });

  it('stays quiet at or below the threshold, and fires on a fall as well as a rise', () => {
    expect(checkRevenueStale(iso('2026-08-17'), index, 40)).toBeNull();
    const fallen = [...index.slice(0, 3), { observedAt: iso('2026-09-19'), value: 60 }];
    expect(checkRevenueStale(iso('2026-08-17'), fallen, 30)!.detail.move_pct).toBeCloseTo(-40, 9);
  });

  it('falls back to the earliest index value when none is within seven days, and says so', () => {
    const found = checkRevenueStale(iso('2026-06-01'), index, 30)!;
    expect(found.detail).toMatchObject({ basis: 'earliest_available', index_at_disclosure: { value: 90, observed_at: iso('2026-08-10') } });
    expect(String(found.detail.note)).toMatch(/earliest available/);
  });

  it('has nothing to say without an index, with a single point, or with a non-positive base', () => {
    expect(checkRevenueStale(iso('2026-08-17'), [], 30)).toBeNull();
    expect(checkRevenueStale(iso('2026-08-17'), [index[1]], 30)).toBeNull();
    expect(checkRevenueStale(iso('2026-08-17'), [{ observedAt: iso('2026-08-17'), value: 0 }, index[3]], 30)).toBeNull();
  });
});

describe('fetchAsset: derived metrics and the stale-revenue alert', () => {
  const WITH_INDEX = INGEST_ASSET_YAML.replace(
    '  staker_emission_share: { type: level, unit: ratio, staleness_days: 30 }',
    '  staker_emission_share: { type: level, unit: ratio, staleness_days: 30 }\n' +
      '  usage_index: { type: level, unit: usd_per_day, staleness_days: 7, source: { type: derived, name: burn_momentum, params: { metric: flow_usd.fees_programmatic, days: 3 } } }',
  ).replace('revenue_run_rate_usd: { type: level, unit: usd, staleness_days: 60, critical: true }', 'revenue_run_rate_usd: { type: level, unit: usd, staleness_days: 60, critical: true, allow_provisional: true }');

  /** Stored daily rows for the programmatic flow: `values[i]` covers the day `first + i`. */
  const seedDaily = (db: Parameters<typeof insertObservation>[0], first: string, values: number[]) =>
    values.forEach((value, i) =>
      insertObservation(db, { assetId: 'mini', metricKey: 'flow_usd.fees_programmatic', observedAt: addDays(first, i + 1), periodDays: 1, value, source: 'onchain', fetchedAt: NOW.toISOString() }),
    );

  it('validates derived names and params as configuration', async () => {
    const codeOf = async (fn: () => unknown) => Promise.resolve().then(fn).then(() => undefined, (e: unknown) => (e as OrionError).code);
    expect(await codeOf(() => buildPlan(parseAssetYaml(WITH_INDEX.replace('name: burn_momentum', 'name: nope')).config))).toBe('unknown_derived');
    const h = harness({ loaded: parseAssetYaml(WITH_INDEX.replace('metric: flow_usd.fees_programmatic', 'metric: price_usd')) });
    expect(await codeOf(() => fetchAsset(h.db, h.loaded, NOW, h.deps))).toBe('invalid_source_config');
  });

  it('writes the index for every day with a full window and no index row yet, stamped at the period end', async () => {
    const h = harness({ loaded: parseAssetYaml(WITH_INDEX) });
    seedDaily(h.db, '2026-09-10', [30, 60, 90, 120, 150, 180]); // days 10..15; the scan then adds zeros for 16, 17, 18
    const r = await fetchAsset(h.db, h.loaded, NOW, h.deps);
    const index = listActiveObservations(h.db, 'mini', 'usage_index');
    expect(index.map((o) => [o.observedAt.slice(0, 10), o.value])).toEqual([
      ['2026-09-13', 60], ['2026-09-14', 90], ['2026-09-15', 120], ['2026-09-16', 150], ['2026-09-17', 110], ['2026-09-18', 60], ['2026-09-19', 0],
    ]);
    expect(index[0]).toMatchObject({ source: 'onchain', periodDays: null, sourceDetail: 'derived burn_momentum(flow_usd.fees_programmatic, 3d)' });
    expect(r.sources.find((s) => s.sourceId === 'derived:burn_momentum')).toMatchObject({ status: 'ok', metricsWritten: ['usage_index'] });

    const again = await fetchAsset(h.db, h.loaded, NOW, h.deps);
    expect(again.written.filter((w) => w.metricKey === 'usage_index')).toEqual([]);
    expect(again.sources.find((s) => s.sourceId === 'derived:burn_momentum')!.notes).toEqual(['usage_index: no new day with 3 complete days behind it']);
    expect(listActiveObservations(h.db, 'mini', 'usage_index')).toHaveLength(7);
  });

  it('rewrites an index day whose window changed after a rescan, leaving days it does not cover untouched', async () => {
    const h = harness({ loaded: parseAssetYaml(WITH_INDEX) });
    seedDaily(h.db, '2026-09-10', [30, 60, 90, 120, 150, 180]); // days 10..15; the scan then adds zeros for 16, 17, 18
    await fetchAsset(h.db, h.loaded, NOW, h.deps);
    const before = listActiveObservations(h.db, 'mini', 'usage_index');
    expect(before.map((o) => o.value)).toEqual([60, 90, 120, 150, 110, 60, 0]);
    const idBefore = new Map(before.map((o) => [o.observedAt, o.id]));

    // A --backfill-days rescan supersedes the stored row covering 2026-09-12 (period end 2026-09-13) with a different value.
    insertObservation(h.db, {
      assetId: 'mini', metricKey: 'flow_usd.fees_programmatic', observedAt: '2026-09-13', periodDays: 1, value: 999, source: 'onchain', fetchedAt: NOW.toISOString(),
    });

    const r = await fetchAsset(h.db, h.loaded, NOW, h.deps);
    const after = listActiveObservations(h.db, 'mini', 'usage_index');
    const idAfter = new Map(after.map((o) => [o.observedAt, o.id]));

    // The three-day trailing windows ending 2026-09-12/13/14 (index days 2026-09-13/14/15) include the
    // changed day and are rewritten; the windows ending 15/16/17/18 do not include it and stay put.
    expect(after.map((o) => [o.observedAt.slice(0, 10), o.value])).toEqual([
      ['2026-09-13', 363], ['2026-09-14', 393], ['2026-09-15', 423], ['2026-09-16', 150], ['2026-09-17', 110], ['2026-09-18', 60], ['2026-09-19', 0],
    ]);
    for (const day of ['2026-09-13', '2026-09-14', '2026-09-15']) {
      expect(idAfter.get(`${day}T00:00:00.000Z`)).not.toBe(idBefore.get(`${day}T00:00:00.000Z`));
    }
    for (const day of ['2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19']) {
      expect(idAfter.get(`${day}T00:00:00.000Z`)).toBe(idBefore.get(`${day}T00:00:00.000Z`));
    }
    expect(r.sources.find((s) => s.sourceId === 'derived:burn_momentum')).toMatchObject({ status: 'ok', metricsWritten: ['usage_index'] });
  });

  it('raises the advisory alert when usage has moved since the revenue disclosure, once per disclosure', async () => {
    const h = harness({ loaded: parseAssetYaml(WITH_INDEX) });
    seedDaily(h.db, '2026-09-10', [100, 100, 100, 100, 100, 100]);
    insertObservation(h.db, {
      assetId: 'mini', metricKey: 'revenue_run_rate_usd', observedAt: '2026-09-14', value: 1000, source: 'manual', status: 'provisional',
      citationUrl: 'https://example.com', fetchedAt: NOW.toISOString(),
    });
    const r = await fetchAsset(h.db, h.loaded, NOW, h.deps);
    // index: 100 through 2026-09-16, then 66.7, 33.3, 0 as three zero-burn days roll in. Nearest the disclosure: 100. Latest: 0.
    const alert = r.anomalies.find((a) => a.kind === 'revenue_disclosure_stale')!;
    expect(alert).toMatchObject({ metricKey: 'revenue_run_rate_usd', severity: 'advisory', dedupeKey: '2026-09-14T00:00:00.000Z' });
    expect(alert.detail).toMatchObject({ basis: 'near_disclosure', threshold_pct: 30, index_at_disclosure: { value: 100 }, index_latest: { value: 0 } });
  });

  it('evaluates a dry run over the rows it would write, and writes none', async () => {
    const h = harness({ loaded: parseAssetYaml(WITH_INDEX) });
    seedDaily(h.db, '2026-09-10', [100, 100, 100, 100, 100, 100]);
    insertObservation(h.db, { assetId: 'mini', metricKey: 'revenue_run_rate_usd', observedAt: '2026-09-14', value: 1000, source: 'manual', fetchedAt: NOW.toISOString() });
    const r = await fetchAsset(h.db, h.loaded, NOW, h.deps, { dryRun: true });
    expect(listActiveObservations(h.db, 'mini', 'usage_index')).toEqual([]);
    expect(r.written.filter((w) => w.metricKey === 'usage_index')).toHaveLength(7);
    expect(r.anomalies.find((a) => a.kind === 'revenue_disclosure_stale')).toMatchObject({ id: null });
  });

  it('does nothing for an asset without a usage_index metric', async () => {
    const h = harness();
    const r = await fetchAsset(h.db, h.loaded, NOW, h.deps);
    expect(r.sources.some((s) => s.sourceId.startsWith('derived:'))).toBe(false);
    expect(r.anomalies).toEqual([]);
  });
});
