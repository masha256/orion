import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseAssetYaml } from '../../src/config/load.js';
import type { Db } from '../../src/db/connection.js';
import { insertObservation } from '../../src/db/observations.js';
import { addDays } from '../../src/ingest/time.js';
import { lastCompleteReportDay, loadHolderYieldReport, type YieldReport } from '../../src/report/load.js';
import { MINI_ASSET_YAML, MINI_REPORT_YAML, seedMiniReport } from '../helpers/assets.js';
import { useTestDb } from '../helpers/db.js';
import { repoAsset } from '../helpers/syntheticReport.js';
import { TEST_PROVENANCE, testProvenance } from '../helpers/provenance.js';

const testDb = useTestDb();

/** The HYPE fixture plus a revenue proxy: revenue is the proxy, the buys are paid to holders, protocol the rest. */
const hypeYaml = readFileSync(fileURLToPath(new URL('../fixtures/hype.yaml', import.meta.url)), 'utf8');
const yaml = `${hypeYaml.replace('metrics:\n', 'metrics:\n  flow_usd.revenue_proxy: { type: flow, unit: usd, staleness_days: 4, monitor_only: true }\n')}income_statement:
  category: perp_dex
  scope: complete
  window_days: 10
  revenue:
    - { id: trading, metric: flow_usd.revenue_proxy }
  holders:
    - { id: buyback, metric: flow_usd.buyback, bucket: hold, haircut: 0, recipient_base: all, capture_rule: programmatic }
  remainder: protocol
`;
const statementOf = (r: unknown) => (r as YieldReport).incomeStatement!;

/** Daily rows for `days` days ending on `lastDay` (a day's row is stamped at the end of the day). */
async function seed(db: Db, metricKey: string, lastDay: string, days: number, value: number) {
  for (let i = 0; i < days; i++) {
    const day = addDays(lastDay, -i);
    await insertObservation(db, {
      provenance: testProvenance('api'),
      assetId: 'hype', metricKey, observedAt: `${addDays(day, 1)}T00:00:00.000Z`, periodDays: 1, value, fetchedAt: '2026-10-11T00:00:00.000Z',
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
    const r = statementOf(await loadHolderYieldReport(db, asset));
    expect(r.day).toBe('2026-10-09');
    expect(r.revenue.annualized).toBeCloseTo(2 * 365);
    expect(r.ratios.payoutRatio).toBeCloseTo(1);
  });

  // Task 11 (ruling R11.1 B): the day gates on every flow the statement reads. yCRV's by-sender flows now gate it (they
  // come from flow_usd.yearn_gross's own scan); v1's st-yCRV fee, which no line reads, no longer does.
  it("yCRV: the by-sender flows gate the day; the st-yCRV fee does not", async () => {
    const asset = repoAsset('ycrv');
    const db = testDb();
    const rows = async (m: string, last: string) => {
      for (let i = 0; i < 200; i++) {
        const day = addDays(last, -i);
        await insertObservation(db, { provenance: testProvenance('onchain'), assetId: 'ycrv', metricKey: m, observedAt: `${addDays(day, 1)}T00:00:00.000Z`, periodDays: 1, value: 10, fetchedAt: '2026-10-11T00:00:00.000Z' });
      }
    };
    for (const m of ['flow_usd.fees', 'flow_usd.yearn_revenue', 'flow_usd.yearn_gross']) await rows(m, '2026-10-10');
    expect(await lastCompleteReportDay(db, asset)).toBeNull();
    await rows('flow_usd.yearn_gross_fees', '2026-10-10');
    await rows('flow_usd.yearn_gross_incentives', '2026-10-09');
    expect(await lastCompleteReportDay(db, asset)).toBe('2026-10-09');
    const r = statementOf(await loadHolderYieldReport(db, asset));
    expect(r.day).toBe('2026-10-09');
    expect(r.flags.filter((f) => f.startsWith('apportion'))).toEqual([]);
  });

  it('is null while any report flow has no row', async () => {
    const asset = parseAssetYaml(yaml).config;
    const db = testDb();
    await seed(db, 'flow_usd.buyback', '2026-10-10', 5, 1);
    expect(await lastCompleteReportDay(db, asset)).toBeNull();
  });
});

describe('loadHolderYieldReport (D9; v1 retired, Task 11)', () => {
  it('report yield --json: the header, the statement, the notes; no v1 key', async () => {
    const asset = parseAssetYaml(MINI_REPORT_YAML).config;
    const db = testDb();
    await seedMiniReport(db, '2026-10-10');
    const r = await loadHolderYieldReport(db, asset, '2026-10-10');
    expect(Object.keys(r)).toEqual(['asset', 'day', 'windowDays', 'price', 'marketCap', 'fdv', 'incomeStatement', 'notes']);
    expect(statementOf(r)).toMatchObject({ schema: 2, day: '2026-10-10', scope: 'complete', grossProfit: { annualized: null } });
  });

  it('an asset without income_statement has no report', async () => {
    const asset = parseAssetYaml(MINI_ASSET_YAML).config;
    await expect(loadHolderYieldReport(testDb(), asset, '2026-10-10')).rejects.toThrow(/has no income_statement block/);
  });
});

describe('the statement reads its own disclosed metric (fix round 1, M8)', () => {
  /** MINI disclosing its revenue through `disclosed_b` (another level, revenue_run_rate_usd, also has rows). */
  const disclosedYaml = `${MINI_ASSET_YAML.replace('metrics:\n', 'metrics:\n  disclosed_b: { type: level, unit: usd, staleness_days: 60 }\n')}income_statement:
  category: ai_platform
  scope: complete
  window_days: 10
  revenue:
    - { id: business, disclosed: disclosed_b }
  holders:
    - { id: fees_paid, metric: flow_usd.fees, bucket: cash, haircut: 0, recipient_base: all, capture_rule: contractual }
  remainder: protocol
`;

  it('the disclosed line reads the metric its disclosed key names, up to the report as-of', async () => {
    const asset = parseAssetYaml(disclosedYaml).config;
    const db = testDb();
    await seedMiniReport(db, '2026-10-10');
    const at = (d: string) => `${d}T00:00:00.000Z`;
    for (const [key, value, day] of [['revenue_run_rate_usd', 1000, '2026-06-01'], ['disclosed_b', 50_000, '2026-05-01'], ['disclosed_b', 60_000, '2026-09-01'], ['disclosed_b', 70_000, '2026-10-20']] as const) {
      await insertObservation(db, { provenance: testProvenance('manual'), assetId: 'mini', metricKey: key, observedAt: at(day), value, fetchedAt: at(day) });
    }
    const r = statementOf(await loadHolderYieldReport(db, asset, '2026-10-10'));
    expect(r.revenue.annualized).toBe(60_000);
    expect(r.revenue.lines[0].growth.prior).toBe(50_000);
  });
});
