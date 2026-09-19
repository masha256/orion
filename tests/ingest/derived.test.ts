import { describe, expect, it } from 'vitest';
import { parseAssetYaml } from '../../src/config/load.js';
import { insertObservation, listActiveObservations } from '../../src/db/observations.js';
import { checkRevenueStale } from '../../src/ingest/alerts.js';
import { burnMomentum } from '../../src/ingest/derived.js';
import { buildPlan } from '../../src/ingest/plan.js';
import { fetchAsset } from '../../src/ingest/run.js';
import { addDays } from '../../src/ingest/time.js';
import type { OrionError } from '../../src/types.js';
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
