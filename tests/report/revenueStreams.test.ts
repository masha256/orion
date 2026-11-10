import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseAssetYaml } from '../../src/config/load.js';
import type { Db } from '../../src/db/connection.js';
import { insertObservation } from '../../src/db/observations.js';
import { addDays } from '../../src/ingest/time.js';
import type { ReportLevels } from '../../src/report/holderYield.js';
import { incomeStatementV2 } from '../../src/report/incomeStatement.js';
import { lastCompleteReportDay, loadHolderYieldReport, periodicDaily, type YieldReport } from '../../src/report/load.js';
import { useTestDb } from '../helpers/db.js';
import { testProvenance } from '../helpers/provenance.js';

const testDb = useTestDb();

/**
 * Periodic and young revenue lines (Mike, 2026-10-12; income_statement since Task 11 retired `reporting.revenue`): a
 * periodic line's lump payments are spread over the days they cover, the unpaid tail at the last period's daily rate,
 * provisional; a line younger than the window runs at its own days' rate; growth with and without lines younger than
 * 180 days. HYPE's shape: a daily trading line, the reserve yield periodic and paid on to holders.
 */
const hypeYaml = readFileSync(fileURLToPath(new URL('../fixtures/hype.yaml', import.meta.url)), 'utf8');
const METRICS =
  '  flow_usd.trading: { type: flow, unit: usd, staleness_days: 4, monitor_only: true }\n' +
  '  flow_usd.reserve: { type: flow, unit: usd, cadence: monthly, staleness_days: 45, monitor_only: true }\n';

const streamsYaml = (window = 10, started = '2026-01-15') => `${hypeYaml.replace('metrics:\n', `metrics:\n${METRICS}`)}income_statement:
  category: perp_dex
  scope: complete
  window_days: ${window}
  revenue:
    - { id: trading, metric: flow_usd.trading, settlement: daily }
    - { id: reserve, label: reserve yield, metric: flow_usd.reserve, settlement: periodic, started: "${started}" }
  holders:
    - { id: buyback, metric: flow_usd.buyback, bucket: hold, haircut: 0, recipient_base: all, capture_rule: programmatic }
    - { id: reserve_paid, of: reserve, bucket: burn, haircut: 0, recipient_base: all, capture_rule: programmatic }
  remainder: protocol
`;

const levels: ReportLevels = { price: 2, totalSupply: 1000, stakedSupply: 400, lockedSupply: null, emissionRateAnnual: 0, extra: {}, disclosed: [] };
const flat = (first: string, n: number, v: number) => new Map(Array.from({ length: n }, (_, i) => [addDays(first, i), v] as const));

async function seedDaily(db: Db, metricKey: string, lastDay: string, days: number, value: number) {
  for (let i = 0; i < days; i++) {
    const day = addDays(lastDay, -i);
    await insertObservation(db, { provenance: testProvenance('api'), assetId: 'hype', metricKey, observedAt: `${addDays(day, 1)}T00:00:00.000Z`, periodDays: 1, value, fetchedAt: '2026-10-11T00:00:00.000Z' });
  }
}

describe('revenue lines: periodic settlement', () => {
  it('spreads each payment evenly over the days it covers, and runs the unpaid days at the last period\'s daily rate, provisional', async () => {
    const db = testDb();
    // 300 paid for 2026-01-01 .. 01-30 (30 days): 10 a day. Report day 02-05: 6 unpaid days.
    await insertObservation(db, { provenance: testProvenance('api'), assetId: 'hype', metricKey: 'flow_usd.reserve', observedAt: '2026-01-31T00:00:00.000Z', periodDays: 30, value: 300, fetchedAt: '2026-02-06T00:00:00.000Z' });
    const p = await periodicDaily(db, 'hype', 'flow_usd.reserve', '2026-02-05');
    expect(p.days.get('2026-01-01')).toBe(10);
    expect(p.days.get('2026-01-30')).toBe(10);
    expect(p.days.get('2025-12-31')).toBeUndefined();
    expect([...p.provisional].sort()).toEqual(['2026-01-31', '2026-02-01', '2026-02-02', '2026-02-03', '2026-02-04', '2026-02-05']);
    expect(p.days.get('2026-02-05')).toBe(10);
    // The next payment lands (330 for 01-31 .. 03-01): its days replace the provisional ones; nothing was stored for them.
    await insertObservation(db, { provenance: testProvenance('api'), assetId: 'hype', metricKey: 'flow_usd.reserve', observedAt: '2026-03-02T00:00:00.000Z', periodDays: 30, value: 330, fetchedAt: '2026-02-06T00:00:00.000Z' });
    const q = await periodicDaily(db, 'hype', 'flow_usd.reserve', '2026-02-05');
    expect(q.days.get('2026-02-05')).toBe(11);
    expect(q.provisional.size).toBe(0);
  });

  it('sums the lines; a young line runs at its own days\' rate; the periodic one never holds back the report day', async () => {
    const asset = parseAssetYaml(streamsYaml(10, '2026-01-25')).config;
    const db = testDb();
    await seedDaily(db, 'flow_usd.trading', '2026-02-05', 40, 3);
    await seedDaily(db, 'flow_usd.buyback', '2026-02-05', 40, 2);
    // Started 01-25: one payment for 01-25 .. 02-01 (8 days, 80), unpaid since: 4 provisional days to 02-05.
    await insertObservation(db, { provenance: testProvenance('api'), assetId: 'hype', metricKey: 'flow_usd.reserve', observedAt: '2026-02-02T00:00:00.000Z', periodDays: 8, value: 80, fetchedAt: '2026-02-06T00:00:00.000Z' });
    expect(await lastCompleteReportDay(db, asset)).toBe('2026-02-05');
    const r = (await loadHolderYieldReport(db, asset)) as YieldReport;
    const v = r.incomeStatement!.revenue;
    expect(v.lines.map((l) => [l.id, l.settlement, l.provisionalDays, l.isNew])).toEqual([
      ['trading', 'daily', 0, false],
      ['reserve', 'periodic', 4, true], // 12 days old: older than the 10-day window, younger than 180
    ]);
    expect(v.lines[0].annualized).toBeCloseTo(3 * 365);
    expect(v.lines[1].annualized).toBeCloseTo(10 * 365);
    expect(v.annualized).toBeCloseTo(13 * 365);
    expect(v.provisional).toBe(true);
    // Growth as is: the reserve was zero in the prior window (before it started), so revenue grew; without it, flat.
    expect(v.growth.prior).toBeCloseTo(3 * 10 + 10 * 2); // 01-17 .. 01-26: 2 days of reserve
    expect(v.growth.current).toBeCloseTo(13 * 10);
    expect(v.excludedFromExNew).toEqual(['reserve']);
    expect(v.growthExNew!.change).toBeCloseTo(0);
    // Paid to holders: the buys and the reserve; protocol is the rest.
    expect(r.incomeStatement!.holders.annualized).toBeCloseTo((2 + 10) * 365);
    expect(r.incomeStatement!.protocol.annualized).toBeCloseTo(1 * 365);
    expect(r.incomeStatement!.holderFlow.lines.map((f) => [f.id, f.bucket])).toEqual([['buyback', 'hold'], ['reserve_paid', 'burn']]);
    expect(r.notes.join('\n')).toMatch(/reserve has 4 unpaid day\(s\) at the last period's daily rate \(provisional\)/);
  });

  it('annualizes a line younger than the window over its own days, not the whole window', () => {
    const asset = parseAssetYaml(streamsYaml(10, '2026-01-31')).config;
    const daily = new Map([
      ['flow_usd.buyback', flat('2026-01-01', 40, 1)],
      ['flow_usd.trading', flat('2026-01-01', 40, 1)],
      ['flow_usd.reserve', flat('2026-01-31', 6, 5)], // 6 days to 02-05, 5 a day
    ]);
    const v2 = incomeStatementV2({ asset, day: '2026-02-05', daily, levels });
    const reserve = v2.revenue.lines[1];
    expect(reserve.daysMeasured).toBe(6);
    expect(reserve.annualized).toBeCloseTo(5 * 365); // not 30 / 10 * 365
  });
});
