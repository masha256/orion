import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseAssetYaml } from '../../src/config/load.js';
import type { Db } from '../../src/db/connection.js';
import { insertObservation } from '../../src/db/observations.js';
import { addDays } from '../../src/ingest/time.js';
import { holderYieldReport } from '../../src/report/holderYield.js';
import { lastCompleteReportDay, loadHolderYieldReport, yieldReport } from '../../src/report/load.js';
import { MINI_ASSET_YAML, MINI_REPORT_YAML, seedMiniReport } from '../helpers/assets.js';
import { useTestDb } from '../helpers/db.js';
import { ALL_ASSETS, repoAsset, syntheticInput } from '../helpers/syntheticReport.js';
import { TEST_PROVENANCE } from '../helpers/provenance.js';

const testDb = useTestDb();

/** The HYPE fixture (one holder flow, flow_usd.buyback) plus a revenue proxy that the income statement totals. */
const hypeYaml = readFileSync(fileURLToPath(new URL('../fixtures/hype.yaml', import.meta.url)), 'utf8');
const yaml = `${hypeYaml.replace('metrics:\n', 'metrics:\n  flow_usd.revenue_proxy: { type: flow, unit: usd, staleness_days: 4, monitor_only: true }\n')}
reporting:
  window_days: 10
  haircuts: { buyback: 0 }
  income:
    lines:
      - { id: buyback, to: holders, metric: flow_usd.buyback }
    remainder_of: [ flow_usd.revenue_proxy ]
`;

/** Daily rows for `days` days ending on `lastDay` (a day's row is stamped at the end of the day). */
async function seed(db: Db, metricKey: string, lastDay: string, days: number, value: number) {
  for (let i = 0; i < days; i++) {
    const day = addDays(lastDay, -i);
    await insertObservation(db, {
      provenance: TEST_PROVENANCE,
      assetId: 'hype', metricKey, observedAt: `${addDays(day, 1)}T00:00:00.000Z`, periodDays: 1, value, source: 'api', fetchedAt: '2026-10-11T00:00:00.000Z',
    });
  }
}

describe('lastCompleteReportDay', () => {
  it('is the newest day every report flow has, so a series a day behind is not left blank', async () => {
    const asset = parseAssetYaml(yaml).config;
    const db = testDb();
    await seed(db, 'flow_usd.buyback', '2026-10-10', 25, 2); // a day ahead
    await seed(db, 'flow_usd.revenue_proxy', '2026-10-09', 25, 2);
    expect(await lastCompleteReportDay(db, asset)).toBe('2026-10-09');
    const r = await loadHolderYieldReport(db, asset, undefined, { legacy: true });
    expect(r.day).toBe('2026-10-09');
    expect(r.income!.revenue.annualized).toBeCloseTo(2 * 365);
    expect(r.income!.payoutRatio).toBeCloseTo(1);
  });

  it('is null while any report flow has no row', async () => {
    const asset = parseAssetYaml(yaml).config;
    const db = testDb();
    await seed(db, 'flow_usd.buyback', '2026-10-10', 5, 1);
    expect(await lastCompleteReportDay(db, asset)).toBeNull();
  });
});

describe('loadHolderYieldReport: v2 and --legacy (D9, Task 4)', () => {
  const V1_KEYS = ['asset', 'day', 'windowDays', 'price', 'marketCap', 'fdv', 'flows', 'buckets', 'yields', 'holderFlowGrowth', 'supply', 'income', 'revenue', 'volume', 'revenueDisclosed', 'notes'];

  it('report yield --json omits legacy keys; --legacy keeps them in v1 order', async () => {
    const asset = parseAssetYaml(MINI_REPORT_YAML).config;
    const db = testDb();
    await seedMiniReport(db, '2026-10-10');
    const slim = await loadHolderYieldReport(db, asset, '2026-10-10');
    expect(Object.keys(slim)).toEqual(['asset', 'day', 'windowDays', 'price', 'marketCap', 'fdv', 'incomeStatement', 'notes']);
    expect(slim.incomeStatement).toMatchObject({ schema: 2, day: '2026-10-10', scope: 'complete', grossProfit: { annualized: null } });
    const legacy = await loadHolderYieldReport(db, asset, '2026-10-10', { legacy: true });
    expect(Object.keys(legacy)).toEqual([...V1_KEYS, 'incomeStatement']);
    expect(legacy.incomeStatement).toEqual(slim.incomeStatement);
    for (const k of ['asset', 'day', 'windowDays', 'price', 'marketCap', 'fdv', 'notes'] as const) expect(slim[k]).toEqual(legacy[k]);
  });

  it('--legacy JSON minus incomeStatement equals the v1 object', async () => {
    const asset = parseAssetYaml(MINI_REPORT_YAML).config;
    const db = testDb();
    await seedMiniReport(db, '2026-10-10');
    const legacy = JSON.parse(JSON.stringify(await loadHolderYieldReport(db, asset, '2026-10-10', { legacy: true }))) as Record<string, unknown>;
    expect(legacy.incomeStatement).toBeDefined();
    delete legacy.incomeStatement;
    // v1 = the same asset without the income_statement block (the previous release's report reads nothing else).
    const { income_statement: _drop, ...v1Asset } = asset;
    const v1 = await loadHolderYieldReport(db, v1Asset, '2026-10-10', { legacy: true });
    expect('incomeStatement' in v1).toBe(false);
    expect(JSON.stringify(legacy)).toBe(JSON.stringify(v1));
    expect((v1 as { income: { revenue: { annualized: number } } }).income.revenue.annualized).toBeGreaterThan(0);
  });

  it('an asset without income_statement: no incomeStatement key either way', async () => {
    const asset = parseAssetYaml(yaml).config;
    const db = testDb();
    await seed(db, 'flow_usd.buyback', '2026-10-09', 25, 2);
    await seed(db, 'flow_usd.revenue_proxy', '2026-10-09', 25, 2);
    expect(Object.keys(await loadHolderYieldReport(db, asset))).toEqual(['asset', 'day', 'windowDays', 'price', 'marketCap', 'fdv', 'notes']);
    expect(Object.keys(await loadHolderYieldReport(db, asset, undefined, { legacy: true }))).toEqual(V1_KEYS);
  });
});

describe('legacyReport on the 13 repo assets (synthetic series)', () => {
  it.each(ALL_ASSETS)('%s: the --legacy object minus incomeStatement is the v1 object byte for byte, incomeStatement last', (id) => {
    const input = syntheticInput(repoAsset(id));
    const v1 = JSON.stringify(holderYieldReport(input));
    const legacy = JSON.parse(JSON.stringify(yieldReport(input, { legacy: true }))) as Record<string, unknown>;
    expect(Object.keys(legacy).at(-1)).toBe('incomeStatement');
    delete legacy.incomeStatement;
    expect(JSON.stringify(legacy)).toBe(v1);
    expect(Object.keys(yieldReport(input))).toEqual(['asset', 'day', 'windowDays', 'price', 'marketCap', 'fdv', 'incomeStatement', 'notes']);
  });
});

describe('the statement reads its own disclosed metric (fix round 1, M8)', () => {
  /** MINI disclosing revenue through `revenue_run_rate_usd` (v1) while its income statement names `disclosed_b`. */
  const yamlOf = (statementMetric: string) => `${MINI_ASSET_YAML.replace('metrics:\n', 'metrics:\n  disclosed_b: { type: level, unit: usd, staleness_days: 60 }\n')}reporting:
  window_days: 10
  haircuts: { fees: 0 }
  revenue_disclosed: revenue_run_rate_usd
  revenue:
    - { id: business, disclosed: revenue_run_rate_usd }
  income:
    lines:
      - { id: fees, to: holders, metric: flow_usd.fees }
income_statement:
  category: ai_platform
  scope: complete
  window_days: 10
  revenue:
    - { id: business, disclosed: ${statementMetric} }
  holders:
    - { id: fees_paid, metric: flow_usd.fees, bucket: cash, haircut: 0, recipient_base: all, capture_rule: contractual }
  remainder: protocol
`;

  async function seedDisclosures(db: Db) {
    await seedMiniReport(db, '2026-10-10');
    const at = (d: string) => `${d}T00:00:00.000Z`;
    for (const [key, value, day] of [['revenue_run_rate_usd', 1000, '2026-06-01'], ['revenue_run_rate_usd', 2000, '2026-10-01'], ['disclosed_b', 50_000, '2026-05-01'], ['disclosed_b', 60_000, '2026-09-01']] as const) {
      await insertObservation(db, { provenance: TEST_PROVENANCE, assetId: 'mini', metricKey: key, observedAt: at(day), value, source: 'manual', fetchedAt: at(day) });
    }
  }

  it('an income statement disclosed key that differs from v1 revenue_disclosed is read on its own (v1 unchanged)', async () => {
    const asset = parseAssetYaml(yamlOf('disclosed_b')).config;
    const db = testDb();
    await seedDisclosures(db);
    const r = await loadHolderYieldReport(db, asset, '2026-10-10', { legacy: true });
    expect(r.revenue!.annualized).toBe(2000);
    expect(r.revenueDisclosed!.latest).toBe(2000);
    expect(r.incomeStatement!.revenue.annualized).toBe(60_000);
    expect(r.incomeStatement!.revenue.lines[0].growth.prior).toBe(50_000);
  });

  it('the same key: the statement reads the v1 disclosures', async () => {
    const asset = parseAssetYaml(yamlOf('revenue_run_rate_usd')).config;
    const db = testDb();
    await seedDisclosures(db);
    const r = await loadHolderYieldReport(db, asset, '2026-10-10', { legacy: true });
    expect(r.incomeStatement!.revenue.annualized).toBe(2000);
    expect(r.incomeStatement!.revenue.growth).toEqual(r.revenue!.growth);
  });
});
