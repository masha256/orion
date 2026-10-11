import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseAssetYaml } from '../../src/config/load.js';
import { openDb } from '../../src/db/connection.js';
import { insertObservation } from '../../src/db/observations.js';
import { addDays } from '../../src/ingest/time.js';
import { lastCompleteReportDay, loadHolderYieldReport } from '../../src/report/load.js';

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
function seed(db: ReturnType<typeof openDb>, metricKey: string, lastDay: string, days: number, value: number) {
  for (let i = 0; i < days; i++) {
    const day = addDays(lastDay, -i);
    insertObservation(db, {
      assetId: 'hype', metricKey, observedAt: `${addDays(day, 1)}T00:00:00.000Z`, periodDays: 1, value, source: 'api', fetchedAt: '2026-10-11T00:00:00.000Z',
    });
  }
}

describe('lastCompleteReportDay', () => {
  it('is the newest day every report flow has, so a series a day behind is not left blank', () => {
    const asset = parseAssetYaml(yaml).config;
    const db = openDb(':memory:');
    seed(db, 'flow_usd.buyback', '2026-10-10', 25, 2); // a day ahead
    seed(db, 'flow_usd.revenue_proxy', '2026-10-09', 25, 2);
    expect(lastCompleteReportDay(db, asset)).toBe('2026-10-09');
    const r = loadHolderYieldReport(db, asset);
    expect(r.day).toBe('2026-10-09');
    expect(r.income!.revenue.annualized).toBeCloseTo(2 * 365);
    expect(r.income!.payoutRatio).toBeCloseTo(1);
  });

  it('is null while any report flow has no row', () => {
    const asset = parseAssetYaml(yaml).config;
    const db = openDb(':memory:');
    seed(db, 'flow_usd.buyback', '2026-10-10', 5, 1);
    expect(lastCompleteReportDay(db, asset)).toBeNull();
  });
});
