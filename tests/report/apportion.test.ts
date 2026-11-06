import { describe, expect, it } from 'vitest';
import { parseAssetYaml } from '../../src/config/load.js';
import { addDays } from '../../src/ingest/time.js';
import { holderYieldReport, type ReportInput } from '../../src/report/holderYield.js';
import { incomeStatementV2 } from '../../src/report/incomeStatement.js';
import { LOCKER_W as W, LOCKER_YAML } from '../helpers/apportionAsset.js';

/**
 * Task 7b: apportion-by-mix lines. A paid flow is split between "from revenue" and "below the line" by the window's
 * sender mix (window sum of `by` / window sum of `total`), method derived; holder flow, yields and buckets stay v1's.
 */
const DAY = '2026-01-20';
const asset = parseAssetYaml(LOCKER_YAML).config;

/** Day i (0 = DAY) of a series: uneven, so the window mix is not any one day's. */
function series(n: number, f: (i: number) => number): Map<string, number> {
  return new Map(Array.from({ length: n }, (_, i) => [addDays(DAY, -i), f(i)] as const));
}

function input(over: Partial<Record<string, Map<string, number>>> = {}): ReportInput {
  const fees = series(30, (i) => 3 + (i % 4) * 0.37);
  const incentives = series(30, (i) => 9 + (i % 3) * 1.13);
  const gross = series(30, (i) => fees.get(addDays(DAY, -i))! + incentives.get(addDays(DAY, -i))!);
  const daily = new Map<string, Map<string, number>>([
    ['flow_usd.gross', gross], ['flow_usd.gross_fees', fees], ['flow_usd.gross_incentives', incentives],
    ['flow_usd.payout', series(30, (i) => 9.4 + (i % 5) * 0.21)], ['flow_usd.treasury', series(30, (i) => 2.3 + (i % 2) * 0.4)],
  ]);
  for (const [k, v] of Object.entries(over)) daily.set(k, v!);
  return {
    asset, day: DAY, daily,
    levels: { price: 0.2, totalSupply: 1000, circulatingSupply: 1000, stakedSupply: 800, lockedSupply: null, emissionRateAnnual: 0, extra: {}, disclosed: [] },
  };
}

const windowSum = (m: Map<string, number>) => Array.from({ length: W }, (_, i) => m.get(addDays(DAY, -i))!).reduce((s, x) => s + x, 0);
const annual = (sum: number) => (sum * 365) / W;

function run(inp = input()) {
  const v1 = holderYieldReport(inp);
  return { inp, v1, v2: incomeStatementV2(inp, v1) };
}

describe('apportion by mix (Task 7b)', () => {
  it('the mix is the window sums ratio; each line carries its flow x its mix', () => {
    const { inp, v2 } = run();
    const d = inp.daily;
    const mixFees = windowSum(d.get('flow_usd.gross_fees')!) / windowSum(d.get('flow_usd.gross')!);
    const mixInc = windowSum(d.get('flow_usd.gross_incentives')!) / windowSum(d.get('flow_usd.gross')!);
    expect(mixFees).toBeGreaterThan(0.2);
    expect(mixFees).toBeLessThan(0.3);
    const ybs = v2.holders.lines.find((l) => l.id === 'ybs_payout')!;
    expect(ybs.apportion).toEqual({
      by: 'flow_usd.gross_fees', total: 'flow_usd.gross', mix: mixFees, bySum: windowSum(d.get('flow_usd.gross_fees')!), totalSum: windowSum(d.get('flow_usd.gross')!), formula: 'apportion_by_mix@1',
    });
    expect(ybs.annualized).toBeCloseTo(annual(windowSum(d.get('flow_usd.payout')!)) * mixFees, 9);
    const treasury = v2.protocol.lines.find((l) => l.id === 'treasury')!;
    expect(treasury.annualized).toBeCloseTo(annual(windowSum(d.get('flow_usd.treasury')!)) * mixFees, 9);
    const incH = v2.belowLine.lines.find((l) => l.id === 'incentives_to_holders')!;
    expect(incH.apportion!.mix).toBe(mixInc);
    expect(incH.annualized).toBeCloseTo(annual(windowSum(d.get('flow_usd.payout')!)) * mixInc, 9);
    expect(v2.belowLine.toHolders).toBe(incH.annualized);
    expect(v2.belowLine.toProtocol).toBe(v2.belowLine.lines.find((l) => l.id === 'incentives_to_protocol')!.annualized);
  });

  it('method is derived on every apportioned line; revenue is the fees line only, measured', () => {
    const { v2 } = run();
    expect(v2.holders.lines[0]!.method).toBe('derived');
    expect(v2.protocol.lines[0]!.method).toBe('derived');
    expect(v2.belowLine.lines.map((l) => l.method)).toEqual(['derived', 'derived']);
    expect(v2.holderFlow.lines.map((l) => [l.id, l.method, l.fromBelowLine])).toEqual([['ybs_payout', 'derived', false], ['incentives_to_holders', 'derived', true]]);
    expect(v2.revenue.lines.map((l) => [l.id, l.method])).toEqual([['fees_rev', 'measured']]);
    expect(v2.provenance.methods.measured).toBe(1);
  });

  it('complementary lines sum to the whole flow; holder flow, its net, bucket, yield and growth are v1 exactly', () => {
    const { v1, v2 } = run();
    const whole = v1.buckets.cash!.gross!;
    const [a, b] = v2.holderFlow.lines.map((l) => l.gross!);
    expect(Math.abs(a! + b! - whole) / whole).toBeLessThan(1e-15);
    const tWhole = annual(windowSum(input().daily.get('flow_usd.treasury')!));
    expect(Math.abs(v2.protocol.annualized! + v2.belowLine.toProtocol! - tWhole) / tWhole).toBeLessThan(1e-15);
    // the totals read the whole flow once: exactly v1's figures
    expect(v2.holderFlow.gross).toBe(whole);
    expect(v2.holderFlow.net).toBe(v1.buckets.cash!.net);
    expect(v2.holderFlow.byBucket.cash!.gross).toBe(whole);
    expect(v2.holderFlow.byBucket.cash!.net).toBe(v1.buckets.cash!.net);
    expect(v2.holderFlow.byBucket.cash!.yield).toBe(v1.buckets.cash!.yield);
    expect(v2.holderFlow.growth.annualized).toBe(v1.holderFlowGrowth.annualized);
    expect(v2.yields).toEqual(v1.yields);
    // only the split between from revenue and below the line is new
    expect(v2.holderFlow.fromRevenue).toBe(a);
    expect(v2.holderFlow.fromBelowLine).toBe(b);
    expect(v2.holderFlow.byBucket.cash!.fromRevenue).toBe(a);
    expect(v2.holderFlow.byBucket.cash!.fromBelowLine).toBe(b);
  });

  it('the yCRV reclass expectation: revenue = v1 volume x mix, below the line to holders = v1 payout x (1 - mix)', () => {
    const { v1, v2 } = run();
    const mix = v2.holders.lines[0]!.apportion!.mix!;
    const rel = (x: number, y: number) => Math.abs(x - y) / Math.max(Math.abs(x), Math.abs(y));
    expect(rel(v2.revenue.annualized!, v1.volume!.annualized! * mix)).toBeLessThan(1e-12);
    const payout = v1.income!.lines.find((l) => l.id === 'ybs_payout')!.annualized!;
    const treasury = v1.income!.lines.find((l) => l.id === 'treasury')!.annualized!;
    expect(rel(v2.belowLine.toHolders!, payout * (1 - mix))).toBeLessThan(1e-12);
    expect(rel(v2.unreconciled.annualized!, v1.volume!.annualized! * mix - payout * mix - treasury * mix)).toBeLessThan(1e-12);
    expect(v2.flags.filter((f) => f.startsWith('apportion'))).toEqual([]);
  });

  it('a total window sum of 0: no mix, the lines are null and flagged, holder flow keeps the whole flow', () => {
    const zero = series(30, () => 0);
    const { v1, v2 } = run(input({ 'flow_usd.gross': zero, 'flow_usd.gross_fees': zero, 'flow_usd.gross_incentives': zero }));
    for (const l of [v2.holders.lines[0]!, v2.protocol.lines[0]!, ...v2.belowLine.lines]) {
      expect(l.annualized, l.id).toBeNull();
      expect(l.apportion!.mix, l.id).toBeNull();
      expect(Number.isFinite(l.apportion!.totalSum!)).toBe(true);
    }
    expect(v2.holders.annualized).toBeNull();
    expect(v2.belowLine.toHolders).toBeNull();
    expect(v2.unreconciled.annualized).toBeNull();
    expect(v2.flags).toContain('apportion mix n/a: ybs_payout, treasury, incentives_to_holders, incentives_to_protocol (the window sum of flow_usd.gross is 0)');
    expect(v2.holderFlow.fromRevenue).toBeNull();
    expect(v2.holderFlow.fromBelowLine).toBeNull();
    expect(v2.holderFlow.gross).toBe(v1.buckets.cash!.gross);
    expect(JSON.stringify(v2)).not.toMatch(/NaN|Infinity/);
  });

  it('a missing day in the by series: no mix, flagged as a missing day', () => {
    const fees = input().daily.get('flow_usd.gross_fees')!;
    fees.delete(addDays(DAY, -2));
    const { v2 } = run(input({ 'flow_usd.gross_fees': fees }));
    expect(v2.holders.lines[0]!.annualized).toBeNull();
    expect(v2.holders.lines[0]!.apportion!.mix).toBeNull();
    expect(v2.flags.some((f) => f.startsWith('apportion mix n/a: ybs_payout, treasury') && f.includes('a day of flow_usd.gross_fees or flow_usd.gross is missing'))).toBe(true);
    // the incentives lines' series are whole: their mix stands
    expect(v2.belowLine.lines[0]!.apportion!.mix).toEqual(expect.any(Number));
  });

  it('an asset without apportion carries no apportion key on any line', () => {
    const plain = parseAssetYaml(LOCKER_YAML.replace(/, apportion: \{ by: flow_usd\.gross_\w+, total: flow_usd\.gross \}/g, '')
      .replace(/  below_line:\n(.*\n){2}/, '')
      .replace(/    - \{ id: splitter.*\n/, '    - { id: splitter, type: sum, total: [ flow_usd.gross ], parts: [ ybs_payout, treasury ], tolerance_pct: 2 }\n')).config;
    const inp = { ...input(), asset: plain };
    const v2 = incomeStatementV2(inp, holderYieldReport(inp));
    expect(JSON.stringify(v2)).not.toContain('apportion');
  });
});
