import { describe, expect, it } from 'vitest';
import { parseAssetYaml } from '../../src/config/load.js';
import { addDays } from '../../src/ingest/time.js';
import { growthOf, holderYieldReport, type ReportLevels } from '../../src/report/holderYield.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const series = (first: string, values: number[]) => new Map(values.map((v, i) => [addDays(first, i), v] as const));
const flat = (first: string, n: number, v: number) => series(first, Array.from({ length: n }, () => v));

describe('growthOf', () => {
  it('compares the latest window with the one before it and annualizes the ratio', () => {
    // 10 days at 1, then 10 days at 2: the latest 10-day window is double the prior one.
    const daily = new Map([['f', series('2026-01-01', [...Array(10).fill(1), ...Array(10).fill(2)])]]);
    const g = growthOf(daily, ['f'], '2026-01-20', 10);
    expect(g.current).toBe(20);
    expect(g.prior).toBe(10);
    expect(g.change).toBeCloseTo(1);
    expect(g.annualized).toBeCloseTo(2 ** 36.5 - 1);
  });
  it('is null until both windows are complete, and n/m when a window is zero', () => {
    const daily = new Map([['f', flat('2026-01-01', 15, 1)]]);
    expect(growthOf(daily, ['f'], '2026-01-15', 10).annualized).toBeNull();
    const zero = new Map([['f', series('2026-01-01', [...Array(10).fill(0), ...Array(10).fill(3)])]]);
    const g = growthOf(zero, ['f'], '2026-01-20', 10);
    expect(g.annualized).toBeNull();
    expect(g.note).toMatch(/not meaningful/);
  });
  it('sums several metrics, each net of its weight', () => {
    const daily = new Map([
      ['a', flat('2026-01-01', 20, 1)],
      ['b', series('2026-01-01', [...Array(10).fill(0), ...Array(10).fill(1)])],
    ]);
    // prior: a 10 + b 0 = 10; current: a 10 + 0.5 * b 10 = 15.
    const g = growthOf(daily, ['a', 'b'], '2026-01-20', 10, [1, 0.5]);
    expect(g.prior).toBe(10);
    expect(g.current).toBe(15);
  });
});

/** The HYPE fixture with a reporting block: one burn-tagged flow plus a revenue proxy. */
const hypeYaml = readFileSync(fileURLToPath(new URL('../fixtures/hype.yaml', import.meta.url)), 'utf8');

describe('holderYieldReport', () => {
  const levels: ReportLevels = {
    price: 2, totalSupply: 1000, stakedSupply: 400, lockedSupply: null, emissionRateAnnual: 50, extra: {}, disclosed: [],
  };

  it('reports market cap on circulating supply and FDV on total supply; the yields stay on total supply', () => {
    const asset = parseAssetYaml(`${hypeYaml}\nreporting: { window_days: 10, haircuts: { buyback: 0 } }\n`).config;
    const daily = new Map([[asset.holder_flows[0].metric, flat('2026-01-01', 20, 1)]]);
    const withCirc = holderYieldReport({ asset, day: '2026-01-20', daily, levels: { ...levels, circulatingSupply: 250 } });
    const without = holderYieldReport({ asset, day: '2026-01-20', daily, levels });
    expect([withCirc.marketCap, withCirc.fdv]).toEqual([500, 2000]);
    expect(withCirc.yields).toEqual(without.yields);
    expect(withCirc.supply).toEqual(without.supply);
  });

  it('puts each holder flow in the bucket its kind names, and derives the yields from them', () => {
    const asset = parseAssetYaml(`${hypeYaml}\nreporting: { window_days: 10, haircuts: { buyback: 0 } }\n`).config;
    const day = '2026-01-20';
    const flowMetric = asset.holder_flows[0].metric;
    const daily = new Map([[flowMetric, flat('2026-01-01', 20, 1)]]);
    const r = holderYieldReport({ asset, day, daily, levels });
    expect(r.flows[0].bucket).toBe(asset.holder_flows[0].kind === 'burn' ? 'burn' : asset.holder_flows[0].kind === 'buy_and_hold' ? 'hold' : 'cash');
    // 10 per window of 10 days: 365 a year, on an FDV of 2000 (price 2 x total supply 1000). No circulating supply: no market cap.
    expect(r.flows[0].gross).toBeCloseTo(365);
    expect(r.fdv).toBe(2000);
    expect(r.marketCap).toBeNull();
    const y = r.yields;
    expect(y.shareholder).toBeCloseTo(365 / 2000);
    expect(y.dilution).toBeCloseTo(0.05);
    expect(y.netShareholder).toBeCloseTo(365 / 2000 - 0.05);
    expect(y.multiple).toBeCloseTo(2000 / 365);
    // Flat flow: growth 0, so the trailing PEG is not meaningful.
    expect(r.holderFlowGrowth.annualized).toBeCloseTo(0);
    expect(y.pegTrailing).toBeNull();
    expect(y.dilutionLines).toBeUndefined();
  });

  it('adds reporting.dilution releases to the dilution, each capped by what is approved', () => {
    const yaml = hypeYaml.replace('metrics:\n', 'metrics:\n  vest_rate: { type: level, unit: tokens_per_year, staleness_days: 7, monitor_only: true }\n  vest_cap: { type: level, unit: tokens, staleness_days: 7, monitor_only: true }\n');
    const asset = parseAssetYaml(`${yaml}\nreporting: { window_days: 10, haircuts: { buyback: 0 }, dilution: [ { id: vest, metric: vest_rate, cap_metric: vest_cap } ] }\n`).config;
    const daily = new Map([[asset.holder_flows[0].metric, flat('2026-01-01', 20, 1)]]);
    const at = (rate: number | null, cap: number | null) => holderYieldReport({ asset, day: '2026-01-20', daily, levels: { ...levels, dilution: { vest: { rate, cap } } } }).yields;
    // emission 50 + vest 100 (cap 300) on 1000 effective: 15 percent.
    expect(at(100, 300).dilution).toBeCloseTo(0.15);
    expect(at(100, 300).dilutionLines).toEqual([{ id: 'vest', tokensPerYear: 100, yield: 0.1 }]);
    // Only 40 approved: the cap binds.
    expect(at(100, 40).dilution).toBeCloseTo(0.09);
    expect(at(100, 40).netShareholder).toBeCloseTo(365 / 2000 - 0.09);
    // Without burned_tokens there is no token supply line.
    expect(holderYieldReport({ asset, day: '2026-01-20', daily, levels: { ...levels, dilution: { vest: { rate: 100, cap: 300 } } } }).supply).toBeNull();
    // An unread line leaves the dilution unknown rather than understated.
    expect(at(null, 40).dilution).toBeNull();
    expect(() => parseAssetYaml(`${hypeYaml}\nreporting: { window_days: 10, haircuts: { buyback: 0 }, dilution: [ { id: vest, metric: nope } ] }\n`)).toThrow(/dilution "vest" metric "nope" is not a level metric/);
  });

  it('sets the tokens burned against the tokens added in one unit (reporting.burned_tokens)', () => {
    const yaml = hypeYaml.replace('metrics:\n', 'metrics:\n  flow_tokens.b: { type: flow, unit: tokens, staleness_days: 4, monitor_only: true }\n  vest_rate: { type: level, unit: tokens_per_year, staleness_days: 7, monitor_only: true }\n');
    const asset = parseAssetYaml(`${yaml}\nreporting: { window_days: 10, haircuts: { buyback: 0 }, burned_tokens: [ flow_tokens.b ], dilution: [ { id: vest, metric: vest_rate } ] }\n`).config;
    // 0.2 tokens a day burned = 73 a year; added: emission 50 + vest 10 = 60. Net -13 on 1000: supply shrinks 1.3 percent.
    const daily = new Map([[asset.holder_flows[0].metric, flat('2026-01-01', 20, 1)], ['flow_tokens.b', flat('2026-01-01', 20, 0.2)]]);
    const s = holderYieldReport({ asset, day: '2026-01-20', daily, levels: { ...levels, dilution: { vest: { rate: 10, cap: null } } } }).supply!;
    expect(s.burnedPerYear).toBeCloseTo(73);
    expect(s.addedPerYear).toBeCloseTo(60);
    expect(s.netPerYear).toBeCloseTo(-13);
    expect(s.netPct).toBeCloseTo(-0.013);
    expect(() => parseAssetYaml(`${hypeYaml}\nreporting: { window_days: 10, haircuts: { buyback: 0 }, burned_tokens: [ ${asset.holder_flows[0].metric} ] }\n`)).toThrow(/is not a flow metric in tokens/);
  });

  it('nets a haircut out of the yield and the growth, and reports the PEG when growth is positive', () => {
    const base = parseAssetYaml(hypeYaml).config;
    const id = base.holder_flows[0].id;
    const yaml = hypeYaml.replace('kind: buy_and_hold', 'kind: fee_share');
    const asset = parseAssetYaml(`${yaml}\nreporting: { window_days: 10, haircuts: { ${id}: 0.1 } }\n`).config;
    const flowMetric = asset.holder_flows[0].metric;
    const daily = new Map([[flowMetric, series('2026-01-01', [...Array(10).fill(1), ...Array(10).fill(1.1)])]]);
    const r = holderYieldReport({ asset, day: '2026-01-20', daily, levels });
    expect(r.flows[0].bucket).toBe('cash');
    expect(r.flows[0].net).toBeCloseTo(r.flows[0].gross! * 0.9);
    expect(r.yields.buyback).toBe(0);
    expect(r.yields.cash).toBeCloseTo(r.flows[0].net! / (recipientsOf(asset.holder_flows[0].recipient_base) * 2));
    expect(r.holderFlowGrowth.change).toBeCloseTo(0.1);
    expect(r.yields.pegTrailing).toBeCloseTo(r.yields.multiple! / (r.holderFlowGrowth.annualized! * 100));
  });

  describe('income statement', () => {
    const withMetrics = hypeYaml.replace(
      'metrics:\n',
      'metrics:\n' +
        ['rev', 'kept', 'kept2', 'cost', 'total', 'reserve'].map((m) => `  flow_usd.${m}: { type: flow, unit: usd, staleness_days: 4, monitor_only: true }\n`).join(''),
    );
    const make = (income: string) => parseAssetYaml(`${withMetrics}\nreporting: { window_days: 10, haircuts: { buyback: 0 }, income: ${income} }\n`).config;
    const day = '2026-01-20';
    const d = (v: number) => flat('2026-01-01', 20, v);

    it('sums its lines into revenue, paid to holders, costs and protocol income, with ratios of revenue', () => {
      const asset = make(`{ lines: [
        { id: h, to: holders, metric: flow_usd.buyback },
        { id: k, to: protocol, metric: flow_usd.kept },
        { id: c, to: cost, estimate: { of: flow_usd.buyback, ratio: 0.05 } } ],
        checks: [ { total: [ flow_usd.total ], parts: [ h, k ] } ],
        outside_revenue: [ { id: r, metric: flow_usd.reserve } ] }`);
      const daily = new Map([['flow_usd.buyback', d(8)], ['flow_usd.kept', d(2)], ['flow_usd.total', d(10.5)], ['flow_usd.reserve', d(1)]]);
      const i = holderYieldReport({ asset, day, daily, levels }).income!;
      const yr = (x: number) => (x * 10 * 365) / 10;
      expect(i.holders.annualized).toBeCloseTo(yr(8));
      expect(i.protocol.annualized).toBeCloseTo(yr(2));
      expect(i.costs.annualized).toBeCloseTo(yr(0.4));
      expect(i.revenue.annualized).toBeCloseTo(yr(10.4));
      expect(i.payoutRatio).toBeCloseTo(8 / 10.4);
      expect(i.protocolMargin).toBeCloseTo(2 / 10.4);
      expect(i.lines.find((l) => l.id === 'c')!.basis).toBe('estimate');
      // The check reports the gap, never books it: parts 10 against a measured 10.5.
      expect(i.checks[0].gapPct).toBeCloseTo((10 / 10.5 - 1) * 100);
      // A reserve payout is listed apart and stays out of the payout ratio.
      expect(i.outsideRevenue[0].annualized).toBeCloseTo(yr(1));
    });

    it('takes protocol income as the remainder of a measured total (a revenue proxy)', () => {
      const asset = make(`{ lines: [ { id: h, to: holders, metric: flow_usd.buyback }, { id: c, to: cost, metric: flow_usd.cost } ], remainder_of: [ flow_usd.rev ] }`);
      const daily = new Map([['flow_usd.buyback', d(7)], ['flow_usd.cost', d(1)], ['flow_usd.rev', d(10)]]);
      const i = holderYieldReport({ asset, day, daily, levels }).income!;
      expect(i.revenue.annualized).toBeCloseTo(365 * 10);
      expect(i.protocol.annualized).toBeCloseTo(365 * 2);
      const rem = i.lines.find((l) => l.basis === 'remainder')!;
      expect(rem.to).toBe('protocol');
      expect(rem.annualized).toBeCloseTo(365 * 2);
      expect(i.protocolMargin).toBeCloseTo(0.2);
    });

    it('grows each part on its own series', () => {
      const asset = make(`{ lines: [ { id: h, to: holders, metric: flow_usd.buyback }, { id: k, to: protocol, metric: flow_usd.kept } ] }`);
      const daily = new Map([['flow_usd.buyback', d(1)], ['flow_usd.kept', series('2026-01-01', [...Array(10).fill(1), ...Array(10).fill(2)])]]);
      const i = holderYieldReport({ asset, day, daily, levels }).income!;
      expect(i.holders.growth.change).toBeCloseTo(0);
      expect(i.protocol.growth.change).toBeCloseTo(1);
      expect(i.revenue.growth.change).toBeCloseTo(0.5);
    });

    it('refuses a line with both or neither of metric and estimate, a protocol line beside remainder_of, and unknown names', () => {
      expect(() => make(`{ lines: [ { id: h, to: holders } ] }`)).toThrow(/metric or an estimate/);
      expect(() => make(`{ lines: [ { id: h, to: holders, metric: flow_usd.buyback, estimate: { of: flow_usd.kept, ratio: 1 } } ] }`)).toThrow(/metric or an estimate/);
      expect(() => make(`{ lines: [ { id: k, to: protocol, metric: flow_usd.kept } ], remainder_of: [ flow_usd.rev ] }`)).toThrow(/list no protocol line/);
      expect(() => make(`{ lines: [ { id: h, to: holders, metric: flow_usd.nope } ] }`)).toThrow(/not a flow metric/);
      expect(() => make(`{ lines: [ { id: h, to: holders, metric: flow_usd.buyback } ], checks: [ { total: [ flow_usd.total ], parts: [ x ] } ] }`)).toThrow(/not a line id/);
      expect(() => make(`{ lines: [ { id: h, to: holders, metric: flow_usd.buyback }, { id: h, to: protocol, metric: flow_usd.kept } ] }`)).toThrow(/used twice/);
    });
  });

  it('refuses a reporting block that misses a holder flow, names a stranger, or haircuts a burn', () => {
    const id = parseAssetYaml(hypeYaml).config.holder_flows[0].id;
    expect(() => parseAssetYaml(`${hypeYaml}\nreporting: { window_days: 10, haircuts: {} }\n`)).toThrow(/haircuts has no entry/);
    expect(() => parseAssetYaml(`${hypeYaml}\nreporting: { window_days: 10, haircuts: { ${id}: 0, nope: 0 } }\n`)).toThrow(/not a holder flow/);
    const burn = hypeYaml.replace('kind: buy_and_hold', 'kind: burn');
    expect(() => parseAssetYaml(`${burn}\nreporting: { window_days: 10, haircuts: { ${id}: 0.1 } }\n`)).toThrow(/is a burn, whose haircut is 0/);
  });

  it('accepts a monitor-only flow metric, and still refuses monitor_only on anything the valuation reads', () => {
    const extra = hypeYaml.replace('metrics:\n', 'metrics:\n  flow_usd.revenue_proxy: { type: flow, unit: usd, staleness_days: 4, monitor_only: true }\n');
    expect(() => parseAssetYaml(extra)).not.toThrow();
    const flowMetric = parseAssetYaml(hypeYaml).config.holder_flows[0].metric;
    const bad = hypeYaml.replace(new RegExp(`(  ${flowMetric.replace('.', '\\.')}: \\{)`), '$1 monitor_only: true,');
    expect(bad).not.toBe(hypeYaml);
    expect(() => parseAssetYaml(bad)).toThrow(/used by the valuation/);
  });

  function recipientsOf(base: string): number {
    return base === 'all' ? levels.totalSupply! : levels.stakedSupply!;
  }
});
