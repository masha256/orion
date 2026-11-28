import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { statementLines } from '../../src/cli/commands/report.js';
import { holderFlowMetrics } from '../../src/config/incomeStatement.js';
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

/**
 * Phase 3 R4 Task 3 (RET-198): a statement whose history starts inside the window (AERO's on-chain revenue from
 * 2026-10-22). Below-line `started` (the same zero-fill and own-days run rate as a revenue line), `in_holder_flow: false`
 * (shown, never holder flow), and the opt-in `history_start` (the window label and the growth guard; Ruling 2026-11-27:
 * without the key the statement is today's, so HYPE and LIT keep their growth).
 */
const R4_METRICS =
  '  flow_usd.voter_fees: { type: flow, unit: usd, staleness_days: 4 }\n' +
  '  flow_usd.vote_incentives: { type: flow, unit: usd, staleness_days: 4 }\n' +
  '  flow_usd.protocol_subsidy: { type: flow, unit: usd, staleness_days: 4 }\n';
const HS = '2026-10-22';
interface R4Opts { historyStart?: string; subsidy?: string; extraBelow?: string }
const r4Yaml = (o: R4Opts = {}) => `${hypeYaml.replace('metrics:\n', `metrics:\n${R4_METRICS}`)}income_statement:
  category: dex
  scope: complete
  window_days: 91
${o.historyStart ? `  history_start: "${o.historyStart}"\n` : ''}  revenue:
    - { id: voter_rev, metric: flow_usd.voter_fees, started: "${HS}" }
  holders:
    - { id: voter_fees, of: voter_rev, bucket: cash, haircut: 0.02, recipient_base: all, capture_rule: contractual }
  remainder: protocol
  below_line:
    - { id: vote_incentives, to: holders, metric: flow_usd.vote_incentives, started: "${HS}", bucket: cash, haircut: 0.03, recipient_base: all, capture_rule: programmatic }
${o.subsidy ?? '    - { id: protocol_subsidy, to: holders, metric: flow_usd.protocol_subsidy, in_holder_flow: false, note: "Aero\'s own money recycled", bucket: cash, haircut: 0, recipient_base: all, capture_rule: programmatic }'}
${o.extraBelow ?? ''}`;
const r4Levels: ReportLevels = { ...levels, circulatingSupply: 600 };
/** Voter fees and incentives from HS (rising, so growth is finite once a prior window has any), the subsidy for 400 days. */
const r4Daily = (day: string) => {
  const from = (first: string, v: (i: number) => number) => {
    const m = new Map<string, number>();
    for (let d = first, i = 0; d <= day; d = addDays(d, 1), i++) m.set(d, v(i));
    return m;
  };
  return new Map([
    ['flow_usd.voter_fees', from(HS, (i) => 100 + i)],
    ['flow_usd.vote_incentives', from(HS, () => 10)],
    ['flow_usd.protocol_subsidy', from(addDays(day, -399), () => 5)],
  ]);
};
const r4 = (day: string, o: R4Opts = {}) => incomeStatementV2({ asset: parseAssetYaml(r4Yaml(o)).config, day, daily: r4Daily(day), levels: r4Levels });
const D36 = '2026-11-26'; // 36 days from HS, inclusive
const sum = (first: string, last: string, v: (i: number) => number) => {
  let s = 0;
  for (let d = first, i = 0; d <= last; d = addDays(d, 1), i++) s += v(i);
  return s;
};

describe('below-line started and in_holder_flow (R4 Task 3)', () => {
  it('below-line started zero-fills and annualizes over its own days; holder flow stays non-null', () => {
    const v2 = r4(D36);
    const inc = v2.belowLine.lines.find((l) => l.id === 'vote_incentives')!;
    expect(inc.annualized).toBeCloseTo(10 * 365); // 360 over 36 days, not 360 / 91 * 365
    expect(inc.started).toBe(HS);
    const voter = (sum(HS, D36, (i) => 100 + i) * 365) / 36;
    const f = v2.holderFlow.lines.find((l) => l.id === 'vote_incentives')!;
    expect(f.gross).toBeCloseTo(10 * 365);
    expect(v2.holderFlow.gross).toBeCloseTo(voter + 10 * 365);
    expect(v2.holderFlow.net).toBeCloseTo(voter * 0.98 + 10 * 365 * 0.97);
    expect(v2.belowLine.toHolders).toBeCloseTo(10 * 365);
  });

  it('in_holder_flow false is rendered and excluded from holder flow and yields', () => {
    const v2 = r4(D36);
    const sub = v2.belowLine.lines.find((l) => l.id === 'protocol_subsidy')!;
    expect(sub.annualized).toBeCloseTo(5 * 365);
    expect(sub.inHolderFlow).toBe(false);
    expect(sub.note).toBe("Aero's own money recycled");
    expect(v2.holderFlow.lines.map((l) => l.id)).toEqual(['voter_fees', 'vote_incentives']);
    const voter = (sum(HS, D36, (i) => 100 + i) * 365) / 36;
    const net = voter * 0.98 + 10 * 365 * 0.97;
    expect(v2.holderFlow.fromBelowLine).toBeCloseTo(10 * 365);
    expect(v2.holderFlow.byBucket.cash!.net).toBeCloseTo(net);
    expect(v2.yields.cash).toBeCloseTo(net / (1000 * 2));
    expect(v2.multiples.mcapToHolderFlow.total).toBeCloseTo((600 * 2) / net);
    expect(v2.perToken.holderFlow.total).toBeCloseTo(net / 600);
    // Below the line to holders is what reaches them: the subsidy is shown, not summed there either.
    expect(v2.belowLine.toHolders).toBeCloseTo(10 * 365);
    expect(v2.flags).toContain('not in holder flow: protocol_subsidy');
    // Nor in the flows holder flow reads (the agent pack's eligibility, the monitor-only rule).
    expect(holderFlowMetrics(parseAssetYaml(r4Yaml()).config.income_statement)).toEqual(['flow_usd.voter_fees', 'flow_usd.vote_incentives']);
  });

  it('in_holder_flow without note is refused', () => {
    const noNote = '    - { id: protocol_subsidy, to: holders, metric: flow_usd.protocol_subsidy, in_holder_flow: false, bucket: cash, haircut: 0, recipient_base: all, capture_rule: programmatic }';
    expect(() => parseAssetYaml(r4Yaml({ subsidy: noNote }))).toThrow(/below_line\.protocol_subsidy takes in_holder_flow: false only with a note/);
    // Left out of holder flow, the line is valued by nobody: it needs no bucket, haircut, recipient base or capture rule.
    const bare = '    - { id: protocol_subsidy, to: holders, metric: flow_usd.protocol_subsidy, in_holder_flow: false, note: "recycled" }';
    expect(() => parseAssetYaml(r4Yaml({ subsidy: bare }))).not.toThrow();
    const toProtocol = '    - { id: protocol_subsidy, to: protocol, metric: flow_usd.protocol_subsidy, in_holder_flow: false, note: "x" }';
    expect(() => parseAssetYaml(r4Yaml({ subsidy: toProtocol }))).toThrow(/below_line\.protocol_subsidy to protocol takes no in_holder_flow/);
  });

  it('below-line started is refused without a metric', () => {
    const runRate = '    - { id: protocol_subsidy, to: protocol, run_rate: revenue_run_rate_usd, started: "2026-10-22" }';
    expect(() => parseAssetYaml(r4Yaml({ subsidy: runRate }))).toThrow(/below_line\.protocol_subsidy takes started only with a metric/);
  });
});

describe('history_start: the window label and the growth guard (R4 Task 3, opt-in)', () => {
  it('window reads 36 of 91 days since 2026-10-22', () => {
    const v2 = r4(D36, { historyStart: HS });
    expect(v2.window).toEqual({ windowDays: 91, daysMeasured: 36, since: HS });
    expect(statementLines(v2)).toContain('  window: 36 of 91 days (since 2026-10-22)');
    // Full history: the field stays, the text line goes.
    const full = r4(addDays(HS, 100), { historyStart: HS });
    expect(full.window).toEqual({ windowDays: 91, daysMeasured: 91, since: HS });
    expect(statementLines(full).some((l) => l.includes('window:'))).toBe(false);
  });

  it('no window field without history_start', () => {
    const v2 = r4(D36);
    expect(v2).not.toHaveProperty('window');
    expect(statementLines(v2).some((l) => l.includes('window:'))).toBe(false);
  });

  it('growth is not meaningful while the prior window starts before history_start', () => {
    const day = addDays(HS, 120);
    // Today's code (no key): the prior window is partly filled, so revenue growth is a finite, inflated number.
    expect(Number.isFinite(r4(day).revenue.growth.change)).toBe(true);
    const v2 = r4(day, { historyStart: HS });
    const note = 'not meaningful: the prior window starts before 2026-10-22';
    const guarded = expect.objectContaining({ change: null, annualized: null, note });
    for (const x of [
      v2.revenue.growth, v2.revenue.growthExNew, ...v2.revenue.lines.map((l) => l.growth), v2.grossProfit.growth,
      v2.holders.growth, ...v2.holders.lines.map((l) => l.growth), v2.protocol.growth, ...v2.protocol.lines.map((l) => l.growth),
      ...v2.belowLine.lines.map((l) => l.growth), v2.holderFlow.growth, ...v2.holderFlow.lines.map((l) => l.growth),
    ]) expect(x).toEqual(guarded);
    expect(v2.yields.pegTrailing).toBeNull();
    expect(statementLines(v2).join('\n')).toContain(`growth n/m (${note})`);
    // The last guarded day: the prior window's first day is the day before history_start.
    expect(r4(addDays(HS, 180), { historyStart: HS }).revenue.growth).toEqual(guarded);
  });

  it('growth is computed once both windows are after history_start', () => {
    for (const day of [addDays(HS, 181), addDays(HS, 182)]) {
      const v2 = r4(day, { historyStart: HS });
      expect(v2.revenue.growth.note).toBeUndefined();
      expect(v2.revenue.growth.change).toEqual(r4(day).revenue.growth.change);
      expect(v2.revenue.growth.change).toBeGreaterThan(0);
      expect(v2.holderFlow.growth).toEqual(r4(day).holderFlow.growth);
    }
  });

  it("a statement without history_start keeps today's growth", () => {
    // HYPE's shape (a young periodic line paid on to holders) and LIT's (a young daily line, half passed to a partner).
    const litYaml = `${hypeYaml.replace('metrics:\n', `metrics:\n${METRICS}`)}income_statement:
  category: perp_dex
  scope: complete
  window_days: 10
  revenue:
    - { id: core, metric: flow_usd.trading, settlement: daily }
    - { id: rh, metric: flow_usd.reserve, settlement: daily, started: "2026-01-25" }
  cost_of_revenue:
    - { id: rh_partner, to: partners, of: rh, share: 0.5 }
  holders:
    - { id: buyback, metric: flow_usd.buyback, bucket: burn, haircut: 0, recipient_base: all, capture_rule: discretionary }
  remainder: protocol
`;
    const daily = new Map([
      ['flow_usd.buyback', flat('2026-01-01', 40, 1)],
      ['flow_usd.trading', flat('2026-01-01', 40, 1)],
      ['flow_usd.reserve', flat('2026-01-25', 12, 5)],
    ]);
    for (const y of [streamsYaml(10, '2026-01-25'), litYaml]) {
      const v2 = incomeStatementV2({ asset: parseAssetYaml(y).config, day: '2026-02-05', daily, levels });
      expect(v2).not.toHaveProperty('window');
      expect(v2.revenue.growth.change).toBeGreaterThan(0);
      expect(v2.revenue.growth.note).toBeUndefined();
      // The same statement opting in: guarded (the prior window starts 01-17, before 01-25).
      const opted = parseAssetYaml(y.replace('  revenue:\n', '  history_start: "2026-01-25"\n  revenue:\n')).config;
      expect(incomeStatementV2({ asset: opted, day: '2026-02-05', daily, levels }).revenue.growth).toEqual(
        expect.objectContaining({ change: null, annualized: null, note: 'not meaningful: the prior window starts before 2026-01-25' }),
      );
    }
  });
});
