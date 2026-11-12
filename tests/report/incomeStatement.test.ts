import { describe, expect, it } from 'vitest';
import { parseAssetYaml } from '../../src/config/load.js';
import type { MetricDef } from '../../src/config/schema.js';
import { addDays } from '../../src/ingest/time.js';
import { disclosedGrowthOf, growthOf, windowSum, type ReportInput, type ReportLevels } from '../../src/report/holderYield.js';
import { incomeStatementV2, listingBar, type IsV2 } from '../../src/report/incomeStatement.js';
import { defaultDayFlowMetrics, reportFlowMetrics } from '../../src/report/load.js';
import { sourceTypeOf } from '../../src/report/sourceTypes.js';
import { ALL_ASSETS, repoAsset, syntheticInput } from '../helpers/syntheticReport.js';

const DAY = '2026-01-20';
const W = 10;
const flat = (n: number, v: number, end = DAY) => new Map(Array.from({ length: n }, (_, i) => [addDays(end, -i), v] as const));

/**
 * A mini asset (tests/helpers/assets.ts style) with a 10-day window: fees 10/day revenue, LP cost 2/day, burn 5/day to
 * holders, treasury 2/day, keepers 0.5/day, bribes 1/day below the line; `isBlock` is its income_statement.
 */
function toy(isBlock: string) {
  const yaml = `
id: toy
symbol: TOY
name: Toy Asset
metrics:
  price_usd: { type: level, unit: usd, staleness_days: 3, critical: true }
  revenue_run_rate_usd: { type: level, unit: usd, staleness_days: 60 }
  total_supply: { type: level, unit: tokens, staleness_days: 7, critical: true }
  circulating_supply: { type: level, unit: tokens, staleness_days: 7 }
  staked_supply: { type: level, unit: tokens, staleness_days: 7 }
  staker_emission_share: { type: level, unit: ratio, staleness_days: 30 }
  emission_rate_annual: { type: schedule, unit: tokens_per_year, staleness_days: 400 }
  bribe_rate_usd: { type: level, unit: usd, staleness_days: 30 }
  flow_usd.fees: { type: flow, unit: usd, staleness_days: 45 }
  flow_usd.lp: { type: flow, unit: usd, staleness_days: 45 }
  flow_usd.burn: { type: flow, unit: usd, staleness_days: 45 }
  flow_usd.treasury: { type: flow, unit: usd, staleness_days: 45 }
  flow_usd.keepers: { type: flow, unit: usd, staleness_days: 45 }
  flow_usd.bribes: { type: flow, unit: usd, staleness_days: 45 }
  flow_usd.yield: { type: flow, unit: usd, staleness_days: 45 }
income_statement:
  category: dex
  scope: complete
  window_days: ${W}
${isBlock}`;
  return parseAssetYaml(yaml).config;
}

const BURN = '  holders: [ { id: burn, metric: flow_usd.burn, bucket: burn, haircut: 0, recipient_base: all, capture_rule: programmatic } ]\n';
const BASE = `  revenue: [ { id: fees, metric: flow_usd.fees } ]
  cost_of_revenue: [ { id: lp, to: lps, metric: flow_usd.lp } ]
${BURN}  protocol: [ { id: treasury, metric: flow_usd.treasury } ]
  operating_costs: [ { id: keepers, metric: flow_usd.keepers } ]
`;

const levels = (over: Partial<ReportLevels> = {}): ReportLevels => ({
  price: 2, totalSupply: 1000, circulatingSupply: 500, stakedSupply: 400, lockedSupply: null, emissionRateAnnual: 50, extra: {}, disclosed: [], ...over,
});

function run(isBlock: string, over: Partial<ReportInput> = {}) {
  const asset = toy(isBlock);
  const daily = new Map([
    ['flow_usd.fees', flat(20, 10)], ['flow_usd.lp', flat(20, 2)], ['flow_usd.burn', flat(20, 5)], ['flow_usd.treasury', flat(20, 2)],
    ['flow_usd.keepers', flat(20, 0.5)], ['flow_usd.bribes', flat(20, 1)],
  ]);
  const input: ReportInput = { asset, day: DAY, daily, levels: levels(), ...over };
  return { v2: incomeStatementV2(input) };
}

const year = (perDay: number) => (perDay * W * 365) / W;

describe('the payout-ratio basis flag (T3/4 M-d, Task 11b)', () => {
  const flag = (v2: { flags: string[] }) => v2.flags.filter((f) => f.startsWith('payout ratio'));

  it('a cost line with no reading (an apportioned cost with no mix) says so, not "a missing day"', () => {
    // The mix's total is zero over the window: the cost is a null level, so gross profit is null and the ratio is on revenue.
    const noMix = `${BASE.replace('revenue: [ { id: fees, metric: flow_usd.fees } ]', 'revenue: [ { id: fees, metric: flow_usd.fees }, { id: side, metric: flow_usd.bribes } ]')
      .replace('{ id: lp, to: lps, metric: flow_usd.lp }', '{ id: lp, to: lps, metric: flow_usd.lp, apportion: { by: flow_usd.bribes, total: flow_usd.burn } }')}  checks: [ { id: part, type: sum, total: [ flow_usd.burn ], parts: [ flow_usd.bribes ], window_days: 1, tolerance_pct: 0.000001 } ]
`;
    expect(noMix).toContain('apportion');
    const zero = new Map([...Array(20).keys()].map((i) => [addDays(DAY, -i), 0] as const));
    const { v2 } = run(noMix, { daily: new Map([['flow_usd.fees', flat(20, 10)], ['flow_usd.lp', flat(20, 2)], ['flow_usd.burn', zero], ['flow_usd.treasury', flat(20, 2)], ['flow_usd.keepers', flat(20, 0.5)], ['flow_usd.bribes', flat(20, 1)]]) });
    expect(v2.grossProfit.annualized).toBeNull();
    expect(v2.ratios.payoutRatioBasis).toBe('revenue');
    expect(flag(v2)).toEqual(['payout ratio on revenue: cost of revenue has no reading: lp']);
  });

  it('a measured cost line missing a day still says "a missing day"', () => {
    const gap = flat(20, 2);
    gap.delete(DAY);
    const { v2 } = run(BASE, { daily: new Map([['flow_usd.fees', flat(20, 10)], ['flow_usd.lp', gap], ['flow_usd.burn', flat(20, 5)], ['flow_usd.treasury', flat(20, 2)], ['flow_usd.keepers', flat(20, 0.5)], ['flow_usd.bribes', flat(20, 1)]]) });
    expect(v2.grossProfit.annualized).toBeNull();
    expect(flag(v2)).toEqual(['payout ratio on revenue: cost of revenue has a missing day']);
  });
});

describe('income statement v2 identities', () => {
  it('revenue - cost = gross profit', () => {
    const { v2 } = run(BASE);
    expect(v2.revenue.annualized).toBeCloseTo(year(10));
    expect(v2.costOfRevenue.annualized).toBeCloseTo(year(2));
    expect(v2.grossProfit.annualized).toBeCloseTo(year(8));
    expect(v2.ratios.takeRate).toBeCloseTo(0.8);
  });

  it('gross profit = holders + protocol + opex + unreconciled', () => {
    const { v2 } = run(BASE);
    expect(v2.holders.annualized).toBeCloseTo(year(5));
    expect(v2.protocol.annualized).toBeCloseTo(year(2));
    expect(v2.operatingCosts.annualized).toBeCloseTo(year(0.5));
    expect(v2.unreconciled.annualized).toBeCloseTo(year(0.5));
    expect(v2.unreconciled.basis).toBe('grossProfit');
    expect(v2.holders.annualized! + v2.protocol.annualized! + v2.operatingCosts.annualized! + v2.unreconciled.annualized!).toBeCloseTo(v2.grossProfit.annualized!);
    expect(v2.unreconciled.pct).toBeCloseTo(0.5 / 8);
  });

  it('remainder closes to 0 unreconciled', () => {
    const { v2 } = run(`  revenue: [ { id: fees, metric: flow_usd.fees } ]
  cost_of_revenue: [ { id: lp, to: lps, metric: flow_usd.lp } ]
${BURN}  operating_costs: [ { id: keepers, metric: flow_usd.keepers } ]
  remainder: protocol
`);
    expect(v2.protocol.remainder).toBe(true);
    expect(v2.protocol.annualized).toBeCloseTo(year(10 - 2 - 5 - 0.5));
    expect(v2.protocol.lines).toEqual([expect.objectContaining({ id: 'remainder', method: 'derived' })]);
    expect(v2.unreconciled.annualized).toBe(0);
  });

  it('a not_measured cost makes grossProfit and takeRate null and lists it in notMeasured, never 0', () => {
    const { v2 } = run(BASE.replace('cost_of_revenue: [ { id: lp, to: lps, metric: flow_usd.lp } ]', 'cost_of_revenue: [ { id: lp, to: lps, metric: flow_usd.lp }, { id: creators, to: creators, not_measured: "not scanned yet" } ]'));
    expect(v2.grossProfit.annualized).toBeNull();
    expect(v2.ratios.takeRate).toBeNull();
    expect(v2.costOfRevenue.annualized).toBeNull();
    expect(v2.costOfRevenue.measuredAnnualized).toBeCloseTo(year(2));
    expect(v2.costOfRevenue.notMeasured).toEqual(['creators']);
    expect(v2.costOfRevenue.lines.find((l) => l.id === 'creators')).toMatchObject({ annualized: null, method: 'not_measured', notMeasured: 'not scanned yet' });
    expect(v2.multiples.mcapToGrossProfit).toBeNull();
    expect(v2.perToken.grossProfit).toBeNull();
    // Unreconciled falls back to revenue less the measured costs.
    expect(v2.unreconciled.basis).toBe('revenue');
    expect(v2.unreconciled.annualized).toBeCloseTo(year(0.5));
  });

  it('payoutRatio = holders / grossProfit when measured (D8)', () => {
    const { v2 } = run(BASE);
    expect(v2.ratios.payoutRatio).toBeCloseTo(5 / 8);
    expect(v2.ratios.payoutRatioBasis).toBe('grossProfit');
  });

  it("payoutRatio falls back to holders / revenue with payoutRatioBasis 'revenue' when a cost is not_measured (correction 14)", () => {
    const { v2 } = run(BASE.replace('{ id: lp, to: lps, metric: flow_usd.lp }', '{ id: lp, to: lps, not_measured: "pools not scanned" }'));
    expect(v2.ratios.payoutRatio).toBeCloseTo(5 / 10);
    expect(v2.ratios.payoutRatioBasis).toBe('revenue');
    expect(v2.flags).toContain('payout ratio on revenue: cost of revenue not measured');
    expect(v2.flags).toContain('cost of revenue not measured: lp');
  });

  it('of inherits periodic settlement and the young-stream weight (HYPE shape)', () => {
    // A periodic stream started 4 days before the report day: 5 of the window's 10 days, so its run rate is x 10/5.
    const started = addDays(DAY, -4);
    const block = `  revenue:
    - { id: fees, metric: flow_usd.fees }
    - { id: yield, metric: flow_usd.yield, settlement: periodic, started: ${started} }
  holders:
    - { id: burn, metric: flow_usd.burn, bucket: burn, haircut: 0, recipient_base: all, capture_rule: programmatic }
    - { id: yield_paid, of: yield, bucket: burn, haircut: 0, recipient_base: all, capture_rule: programmatic }
  remainder: protocol
`;
    const asset = toy(block);
    const daily = new Map([['flow_usd.fees', flat(20, 10)], ['flow_usd.burn', flat(20, 5)], ['flow_usd.yield', flat(5, 3)]]);
    const provisional = new Map([['flow_usd.yield', new Set([DAY, addDays(DAY, -1)])]]);
    const input: ReportInput = { asset, day: DAY, daily, provisional, levels: levels() };
    const v2 = incomeStatementV2(input);
    const y = v2.revenue.lines.find((l) => l.id === 'yield')!;
    expect(y).toMatchObject({ settlement: 'periodic', started, daysMeasured: 5, provisionalDays: 2, isNew: true });
    expect(y.annualized).toBeCloseTo(((3 * 5 * 365) / W) * (W / 5));
    const paid = v2.holders.lines.find((l) => l.id === 'yield_paid')!;
    expect(paid.annualized).toBeCloseTo(y.annualized!);
    expect(paid.gross).toBeCloseTo(y.annualized!);
    expect(v2.revenue.provisional).toBe(true);
    expect(v2.revenue.excludedFromExNew).toEqual(['yield']);
    expect(v2.protocol.annualized).toBeCloseTo(year(10) + y.annualized! - year(5) - paid.annualized!);
  });

  it('below_line to holders adds to holderFlow, flagged fromBelowLine, not to revenue', () => {
    const { v2 } = run(`${BASE}  below_line: [ { id: bribes, metric: flow_usd.bribes, to: holders, bucket: cash, haircut: 0.05, recipient_base: staked, capture_rule: programmatic } ]\n`);
    expect(v2.revenue.annualized).toBeCloseTo(year(10));
    expect(v2.belowLine.toHolders).toBeCloseTo(year(1));
    expect(v2.holderFlow.gross).toBeCloseTo(year(5) + year(1));
    expect(v2.holderFlow.net).toBeCloseTo(year(5) + year(1) * 0.95);
    expect(v2.holderFlow.fromRevenue).toBeCloseTo(year(5));
    expect(v2.holderFlow.fromBelowLine).toBeCloseTo(year(1));
    expect(v2.holderFlow.byBucket.cash).toMatchObject({ fromBelowLine: expect.closeTo(year(1)) });
    expect(v2.holderFlow.lines.find((l) => l.id === 'bribes')).toMatchObject({ fromBelowLine: true, section: 'below_line', bucket: 'cash', haircut: 0.05 });
    // Yield per staked token: net / (400 staked x price 2).
    expect(v2.holderFlow.lines.find((l) => l.id === 'bribes')!.yield).toBeCloseTo((year(1) * 0.95) / 800);
    expect(v2.holders.annualized).toBeCloseTo(year(5));
  });

  it("run_rate below_line line: growth note 'no daily series'", () => {
    const block = `${BASE}  below_line: [ { id: incentives, run_rate: bribe_rate_usd, to: holders, bucket: cash, haircut: 0.03, recipient_base: all, capture_rule: programmatic } ]\n`;
    const { v2 } = run(block, { levels: levels({ extra: { bribe_rate_usd: 1000 } }) });
    const b = v2.belowLine.lines[0];
    expect(b.annualized).toBe(1000);
    expect(b.growth.note).toMatch(/no daily series/);
    expect(v2.holderFlow.lines.find((l) => l.id === 'incentives')).toMatchObject({ gross: 1000, net: 970, metric: null });
    expect(v2.holderFlow.gross).toBeCloseTo(year(5) + 1000);
    // A level has no daily series: holder-flow growth is the burn's alone.
    expect(v2.holderFlow.growth.annualized).toBeCloseTo(0);
  });

  it('perToken = annualized / circulatingSupply; perTokenFdv / totalSupply', () => {
    const { v2 } = run(BASE, { levels: levels({ asOf: '2026-01-21T23:59:59.999Z' }) });
    expect(v2.perToken.circulatingSupply).toBe(500);
    expect(v2.perToken.totalSupply).toBe(1000);
    expect(v2.perToken.supplyAsOf).toBe('2026-01-21T23:59:59.999Z');
    expect(v2.perToken.revenue).toBeCloseTo(year(10) / 500);
    expect(v2.perToken.grossProfit).toBeCloseTo(year(8) / 500);
    expect(v2.perToken.holderFlow.total).toBeCloseTo(year(5) / 500);
    expect(v2.perToken.holderFlow.byBucket).toEqual({ burn: expect.closeTo(year(5) / 500), hold: null, cash: null });
    // Dilution: 50 tokens a year on 1000 (5 percent) x FDV 2000 = $100 a year.
    expect(v2.perToken.dilution).toBeCloseTo((0.05 * 2000) / 500);
    expect(v2.perToken.perTokenFdv.revenue).toBeCloseTo(year(10) / 1000);
    expect(v2.perToken.perTokenFdv.holderFlow.total).toBeCloseTo(year(5) / 1000);
    // The multiples at Orion's day-end price: market cap 1000 (2 x 500).
    expect(v2.multiples.mcapToRevenue).toBeCloseTo(1000 / year(10));
    expect(v2.multiples.mcapToHolderFlow.burn).toBeCloseTo(1000 / year(5));
  });

  it('priceBasis names the day-end price, its source and day', () => {
    const asset = repoAsset('crv');
    const input = syntheticInput(asset);
    const v2 = incomeStatementV2(input);
    expect(v2.priceBasis).toEqual({
      price: 1.7, metric: 'price_usd', sourceType: 'market_data', source: 'market_data:coingecko', day: '2026-11-02', asOf: '2026-11-03T23:59:59.999Z',
      flows: "each flow day's USD at that day's price (the stored value)",
    });
  });

  it("dilution and yields keep v1's arithmetic; checks are empty and provenance.basis is config", () => {
    const { v2 } = run(BASE);
    // The burn (5/day, haircut 0) on FDV 2000: buyback yield = 5 x 365 / 2000; dilution 50 / 1000; no cash bucket (0).
    const buyback = year(5) / (1000 * 2);
    expect(v2.yields).toEqual({
      cash: 0, buyback: expect.closeTo(buyback, 12), shareholder: expect.closeTo(buyback, 12), dilution: 0.05,
      netShareholder: expect.closeTo(buyback - 0.05, 12), multiple: expect.closeTo(1 / buyback, 9), pegTrailing: null,
    });
    expect(v2.dilution).toMatchObject({ pct: 0.05, emissionsPerYear: 50, supply: null });
    expect(v2.checks).toEqual([]);
    expect(v2.provenance.basis).toBe('config');
    expect(v2.provenance.methods).toEqual({ measured: 1, derived: 0, disclosed: 0 });
  });

  it("with the loader's provenance the basis is observations, even on a day it has no row for (Task 10 M-4: no unbackfilled-window fallback)", () => {
    // Every stored day has a row with a method since 0006; a day the map lacks keeps the line's method and its metric's config label.
    const days = new Map(Array.from({ length: W }, (_, i) => [addDays(DAY, -i), { method: 'measured' as const, label: 'log_scan:eip155:8453' }]));
    days.delete(addDays(DAY, -3));
    const { v2 } = run(BASE, { provenance: new Map([['flow_usd.fees', days]]) });
    expect(v2.provenance.basis).toBe('observations');
    expect(v2.provenance.methods).toEqual({ measured: 1, derived: 0, disclosed: 0 });
    expect(v2.revenue.lines[0]).toMatchObject({ id: 'fees', daysMeasured: W - 1 });
  });
});

describe('source types and provenance', () => {
  const def = (source: unknown, extra: object = {}) => ({ type: 'flow', unit: 'usd', fetcher: 'manual', staleness_days: 1, source, ...extra }) as unknown as MetricDef;
  it('sourceTypeOf maps each source to its rung', () => {
    expect(sourceTypeOf(def({ type: 'coingecko', id: 'x', field: 'price' }))).toBe('market_data');
    expect(sourceTypeOf(def({ type: 'transfer_flow' }))).toBe('log_scan');
    expect(sourceTypeOf(def({ type: 'contract_read' }))).toBe('contract_state');
    expect(sourceTypeOf(def({ type: 'erc20_supply' }))).toBe('contract_state');
    expect(sourceTypeOf(def({ type: 'adapter', name: 'hype.fund_buys_daily' }))).toBe('first_party_api');
    expect(sourceTypeOf(def({ type: 'adapter', name: 'lit.exchange_fees_daily' }))).toBe('first_party_api');
    expect(sourceTypeOf(def({ type: 'adapter', name: 'solana.supply_burn_daily' }))).toBe('contract_state');
    expect(sourceTypeOf(def({ type: 'adapter', name: 'lit.unlocks_next_year' }))).toBe('third_party');
    expect(sourceTypeOf(def({ type: 'adapter', name: 'nobody.knows' }))).toBeNull();
    expect(sourceTypeOf(def({ type: 'defillama' }))).toBe('third_party');
    expect(sourceTypeOf(def({ type: 'defillama_share' }))).toBe('third_party');
    expect(sourceTypeOf(def({ type: 'http_json', url: 'https://llama.box/curvedex/api/bribes/stats.json' }))).toBe('third_party');
    expect(sourceTypeOf(def({ type: 'http_json', url: 'https://coins.llama.fi/prices' }))).toBe('third_party');
    expect(sourceTypeOf(def({ type: 'http_json', url: 'https://api.rh.lighter.xyz/api/v1/account' }))).toBe('first_party_api');
    expect(sourceTypeOf(def({ type: 'constant', value: 0, note: 'n' }))).toBe('constant');
    expect(sourceTypeOf(def({ type: 'derived', name: 'flow_annualized' }))).toBe('derived');
    expect(sourceTypeOf(def(undefined))).toBe('disclosure');
  });

  it('every source on the 13 assets has a rung', () => {
    for (const id of ALL_ASSETS) {
      for (const [k, m] of Object.entries(repoAsset(id).metrics)) {
        if (m.source !== undefined || m.fetcher === 'manual') expect(sourceTypeOf(m), `${id} ${k}`).not.toBeNull();
      }
    }
  });

  it('thirdParty lists every line whose metric sourceTypeOf is third_party', () => {
    const tp = (id: string) => {
      const input = syntheticInput(repoAsset(id));
      return incomeStatementV2(input).provenance.thirdParty;
    };
    expect(tp('hype')).toEqual(['revenue.trading', 'holders.af_buyback']);
    expect(tp('pump')).toEqual(['revenue.protocol']);
    expect(tp('aero')).toEqual(['revenue.fees', 'holders.voter_fees']);
    expect(tp('crv')).toEqual(['below_line.vote_incentives', 'below_line.vote_incentives.cross_checks']);
    // Phase 3 R1: LIT's buyback and VVV's burn/revenue DefiLlama cross-checks are gone.
    for (const id of ['cake', 'cvxcrv', 'link', 'lit', 'sdcrv', 'sky', 'uni', 'vvv', 'ycrv']) expect(tp(id), id).toEqual([]);
  });

  it('provenance.sources names each statement series by rung, never a full URL', () => {
    const input = syntheticInput(repoAsset('lit'));
    const v2 = incomeStatementV2(input);
    expect(v2.provenance.sources).toEqual(['first_party_api:lit.app_fee_share', 'first_party_api:lit.exchange_fees_daily', 'first_party_api:lit.treasury_buys_daily']);
  });
});

describe('listingBar (spec §2 deferral, D6)', () => {
  it('revenue, holders and supply lines on an allowed rung pass; a third_party revenue line fails with the line id', () => {
    expect(listingBar(repoAsset('crv'))).toEqual({ ok: true, failing: [] });
    expect(listingBar(repoAsset('vvv'))).toEqual({ ok: true, failing: [] });
    expect(listingBar(repoAsset('hype'))).toEqual({
      ok: false,
      failing: [{ line: 'revenue.trading', sourceType: 'third_party' }, { line: 'holders.af_buyback', sourceType: 'third_party' }],
    });
    expect(listingBar(repoAsset('pump')).failing).toEqual([{ line: 'revenue.protocol', sourceType: 'third_party' }]);
    expect(listingBar(repoAsset('aero')).failing).toEqual([{ line: 'revenue.fees', sourceType: 'third_party' }, { line: 'holders.voter_fees', sourceType: 'third_party' }]);
  });

  it('AERO, HYPE and PUMP are the only assets failing today (reported, not blocked); cost lines may be not_measured', () => {
    const failing = ALL_ASSETS.filter((id) => !listingBar(repoAsset(id)).ok);
    expect(failing).toEqual(['aero', 'hype', 'pump']);
  });

  it('a not_measured holders line fails; an asset without income_statement fails', () => {
    const asset = toy(`  revenue: [ { id: fees, metric: flow_usd.fees } ]
  holders: [ { id: burn, not_measured: "no scan", bucket: burn, haircut: 0, recipient_base: all, capture_rule: programmatic } ]
`);
    // The toy's metrics have no sources: manual entry (disclosure) passes, so only the not_measured line fails.
    expect(listingBar(asset).failing).toEqual([{ line: 'holders.burn', sourceType: null }]);
    expect(listingBar({ ...asset, income_statement: undefined }).failing).toEqual([{ line: 'income_statement', sourceType: null }]);
  });
});

describe('the default report day (Task 11, ruling R11.1 B)', () => {
  /** At cc59fa7 (before Task 11): the flows `lastCompleteReportDay` gated on (v1's set, periodic streams left out). */
  const V1_DAY_FLOWS: Record<string, string[]> = {
    aero: ['flow_usd.fees'],
    cake: ['flow_tokens.burn', 'flow_usd.burn', 'flow_usd.fees', 'flow_usd.treasury'],
    crv: ['flow_usd.curve_treasury', 'flow_usd.fees', 'flow_usd.protocol_revenue'],
    cvxcrv: ['flow_usd.convex_gross_crv', 'flow_usd.convex_rev_cvx', 'flow_usd.convex_rev_cvxcrv', 'flow_usd.convex_rev_treasury', 'flow_usd.crv', 'flow_usd.cvx', 'flow_usd.fees'],
    hype: ['flow_usd.af_buyback', 'flow_usd.revenue_proxy'],
    link: ['flow_usd.reserve'],
    lit: ['flow_tokens.buyback', 'flow_usd.buyback', 'flow_usd.fees_core', 'flow_usd.fees_rh'],
    pump: ['flow_tokens.buyback', 'flow_usd.buyback', 'flow_usd.llama_revenue'],
    sdcrv: ['flow_usd.bribes', 'flow_usd.crv', 'flow_usd.fees', 'flow_usd.sd_boost_delegation', 'flow_usd.sd_gross_crv', 'flow_usd.sd_rev_crv', 'flow_usd.sd_rev_crv_treasury', 'flow_usd.sd_rev_crv_vesdt', 'flow_usd.sd_rev_fees_liquidity', 'flow_usd.sd_rev_fees_treasury'],
    sky: ['flow_usd.buyback', 'flow_usd.stakers'],
    uni: ['flow_tokens.burn', 'flow_usd.burn', 'flow_usd.swap_fees'],
    vvv: ['flow_usd.burn', 'flow_usd.revenue_proxy'],
    ycrv: ['flow_usd.fees', 'flow_usd.yearn_gross', 'flow_usd.yearn_revenue', 'flow_usd.yearn_styc_fee'],
  };
  /** Phase 3 R1 deleted these display/cross-check series, so the gate no longer waits on them. */
  const R1_REMOVED: Record<string, string[]> = { cake: ['flow_usd.fees'], uni: ['flow_usd.swap_fees'], vvv: ['flow_usd.revenue_proxy'] };
  const periodic = (id: string) => new Set(repoAsset(id).income_statement!.revenue.filter((l) => l.settlement === 'periodic').map((l) => l.metric!));
  const dayFlows = (id: string) => [...new Set(defaultDayFlowMetrics(repoAsset(id)))].filter((m) => !periodic(id).has(m)).sort();

  it.each(ALL_ASSETS.filter((id) => id !== 'ycrv'))('%s: gates on exactly the flows it gated on before (the day cannot move)', (id) => {
    expect(dayFlows(id)).toEqual(V1_DAY_FLOWS[id]!.filter((m) => !(R1_REMOVED[id] ?? []).includes(m)));
  });

  it("ycrv: v1's st-yCRV fee leaves (no line reads it), the two by-sender flows of yearn_gross's own scan join", () => {
    // The two join from the one scan that writes flow_usd.yearn_gross (same token, sink, allowlist and cursor), so they
    // end on its day; the fee is a scan of its own that no statement line reads.
    expect(dayFlows('ycrv')).toEqual([...V1_DAY_FLOWS.ycrv.filter((m) => m !== 'flow_usd.yearn_styc_fee'), 'flow_usd.yearn_gross_fees', 'flow_usd.yearn_gross_incentives'].sort());
  });

  it('reads a series only the income statement names', () => {
    const asset = toy(`${BASE}  below_line: [ { id: bribes, metric: flow_usd.bribes, to: holders, bucket: cash, haircut: 0.05, recipient_base: staked, capture_rule: programmatic } ]\n`);
    expect(reportFlowMetrics(asset)).toEqual(['flow_usd.fees', 'flow_usd.lp', 'flow_usd.burn', 'flow_usd.treasury', 'flow_usd.keepers', 'flow_usd.bribes']);
  });
});

/** Fix round 1 (Task 3 review, controller rulings I1-I4, M1-M6, M8). */
describe('fix round 1: disclosed growth and cross-check (I1)', () => {
  const DISCLOSED = `  revenue: [ { id: business, disclosed: revenue_run_rate_usd, cross_check: flow_usd.fees } ]
${BURN}  remainder: protocol
`;

  it("VVV: the disclosed line carries v1's disclosed growth and flags (no cross-check since Phase 3 R1); revenue.growth is it", () => {
    const input = syntheticInput(repoAsset('vvv'));
    const v2 = incomeStatementV2(input);
    const g = disclosedGrowthOf(input.levels.disclosed, input.day);
    expect(g.growth.annualized).toEqual(expect.any(Number));
    expect(v2.revenue.growth).toEqual(g.growth);
    const line = v2.revenue.lines.find((l) => l.id === 'business')!;
    expect(line.growth).toEqual(g.growth);
    expect(line.disclosedGrowth).toEqual(g.disclosedGrowth);
    // Phase 3 R1 removed flow_usd.revenue_proxy (DefiLlama's dailyRevenue); the cross_check form is tested on DISCLOSED below.
    expect(line.crossCheck).toBeUndefined();
  });

  it('one disclosure: growth null with the v1 flag, also in the statement flags', () => {
    const { v2 } = run(DISCLOSED, { levels: levels({ disclosed: [{ observedAt: '2026-01-01T00:00:00.000Z', value: 5000 }] }) });
    expect(v2.revenue.annualized).toBe(5000);
    expect(v2.revenue.growth).toMatchObject({ current: 5000, prior: null, annualized: null, note: 'between the two latest disclosures' });
    const line = v2.revenue.lines[0];
    expect(line.disclosedGrowth).toEqual({ annualized: null, gapDays: null, latestAgeDays: 20, flags: ['one disclosure so far: no growth'] });
    expect(v2.flags).toContain('disclosed revenue: one disclosure so far: no growth');
  });

  it('two disclosures 30 days apart: growth between them, flagged noisy', () => {
    const disclosed = [{ observedAt: '2025-12-01T00:00:00.000Z', value: 4000 }, { observedAt: '2025-12-31T00:00:00.000Z', value: 5000 }];
    const { v2 } = run(DISCLOSED, { levels: levels({ disclosed }) });
    expect(v2.revenue.growth.annualized).toBeCloseTo((5000 / 4000) ** (365 / 30) - 1);
    expect(v2.revenue.lines[0].growth.change).toBeCloseTo(0.25);
    expect(v2.flags).toContain('disclosed revenue: the two latest disclosures are 30 days apart (< 90): a noisy rate');
    expect(v2.revenue.lines[0].crossCheck).toEqual({ metric: 'flow_usd.fees', annualized: expect.closeTo(year(10)), sourceType: 'disclosure' });
  });
});

describe('fix round 1: net of dilution (I2)', () => {
  it('holderFlow.netOfDilution = net - dilution in USD (emissions + releases at price), per token too', () => {
    const { v2 } = run(BASE);
    const dilutionUsd = v2.dilution.pct! * 2 * 1000; // supply growth x FDV
    expect(dilutionUsd).toBeCloseTo(50 * 2); // 50 tokens a year at price 2
    expect(v2.holderFlow.net).toBeCloseTo(year(5));
    expect(v2.holderFlow.netOfDilution).toBeCloseTo(year(5) - dilutionUsd);
    expect(v2.perToken.holderFlow.netOfDilution).toBeCloseTo((year(5) - dilutionUsd) / 500);
    expect(v2.perToken.perTokenFdv.holderFlow.netOfDilution).toBeCloseTo((year(5) - dilutionUsd) / 1000);
  });

  it('netOfDilution is null when dilution is unknown', () => {
    const { v2 } = run(BASE, { levels: levels({ emissionRateAnnual: null }) });
    expect(v2.holderFlow.net).toBeCloseTo(year(5));
    expect(v2.holderFlow.netOfDilution).toBeNull();
  });
});

describe('fix round 1: below-line not measured is never 0 (I3)', () => {
  const NM_BRIBES = '  below_line: [ { id: bribes, to: holders, not_measured: "bribe markets not scanned" } ]\n';
  it('AERO shape: every below-line line to holders not measured -> toHolders and fromBelowLine null, listed', () => {
    const { v2 } = run(`${BASE}${NM_BRIBES}`);
    expect(v2.belowLine.toHolders).toBeNull();
    expect(v2.belowLine.toProtocol).toBe(0);
    expect(v2.belowLine.notMeasured).toEqual(['bribes']);
    expect(v2.holderFlow.fromBelowLine).toBeNull();
    expect(v2.holderFlow.byBucket.burn!.fromBelowLine).toBeNull();
    expect(v2.holderFlow.notMeasured).toEqual(['bribes']);
    // Holder-flow totals keep the measured lines (v1 parity: v1 has no such line).
    expect(v2.holderFlow.gross).toBeCloseTo(year(5));
    expect(v2.holderFlow.fromRevenue).toBeCloseTo(year(5));
  });

  it('AERO (repo) on synthetic series: below line null, not 0', () => {
    const input = syntheticInput(repoAsset('aero'));
    const v2 = incomeStatementV2(input);
    expect(v2.belowLine.toHolders).toBeNull();
    expect(v2.holderFlow.fromBelowLine).toBeNull();
    expect(v2.holderFlow.byBucket.cash!.fromBelowLine).toBeNull();
  });

  it('some measured: the measured sum, the rest listed', () => {
    const { v2 } = run(`${BASE}  below_line:
    - { id: bribes, metric: flow_usd.bribes, to: holders, bucket: cash, haircut: 0, recipient_base: all, capture_rule: programmatic }
    - { id: other_bribes, to: holders, not_measured: "not scanned" }
`);
    expect(v2.belowLine.toHolders).toBeCloseTo(year(1));
    expect(v2.belowLine.notMeasured).toEqual(['other_bribes']);
    expect(v2.holderFlow.fromBelowLine).toBeCloseTo(year(1));
    expect(v2.holderFlow.byBucket.cash!.fromBelowLine).toBeCloseTo(year(1));
    expect(v2.holderFlow.notMeasured).toEqual(['other_bribes']);
  });

  it('no below-line line at all: 0 (nothing below the line), not null', () => {
    const { v2 } = run(BASE);
    expect(v2.belowLine.toHolders).toBe(0);
    expect(v2.holderFlow.fromBelowLine).toBe(0);
    expect(v2.holderFlow.byBucket.burn!.fromBelowLine).toBe(0);
  });
});

describe('fix round 1: not_measured holders, protocol and operating costs propagate (I4)', () => {
  const NM_HOLDER = '    - { id: airdrop, not_measured: "airdrop not scanned", bucket: cash, haircut: 0, recipient_base: all, capture_rule: discretionary }\n';
  const holdersWithNm = `  revenue: [ { id: fees, metric: flow_usd.fees } ]
  cost_of_revenue: [ { id: lp, to: lps, metric: flow_usd.lp } ]
  holders:
    - { id: burn, metric: flow_usd.burn, bucket: burn, haircut: 0, recipient_base: all, capture_rule: programmatic }
${NM_HOLDER}`;

  it('a not_measured holders line: holders total, payout ratio, unreconciled null; listed and flagged', () => {
    const { v2 } = run(`${holdersWithNm}  protocol: [ { id: treasury, metric: flow_usd.treasury } ]\n`);
    expect(v2.holders.annualized).toBeNull();
    expect(v2.holders.notMeasured).toEqual(['airdrop']);
    expect(v2.holders.growth.annualized).toBeNull();
    expect(v2.holders.byBucket.cash).toEqual({ annualized: null });
    expect(v2.holders.byBucket.burn!.annualized).toBeCloseTo(year(5));
    expect(v2.grossProfit.annualized).toBeCloseTo(year(8));
    expect(v2.ratios.payoutRatio).toBeNull();
    expect(v2.unreconciled.annualized).toBeNull();
    expect(v2.unreconciled.pct).toBeNull();
    expect(v2.flags).toContain('not measured: airdrop');
    expect(v2.flags).toContain('payout ratio n/a: holders not measured: airdrop');
    // Holder flow: the holders section is not fully measured, so its totals are null too (the line is listed).
    expect(v2.holderFlow.notMeasured).toEqual(['airdrop']);
    expect(v2.holderFlow.gross).toBeNull();
    expect(v2.holderFlow.net).toBeNull();
    expect(v2.holderFlow.fromRevenue).toBeNull();
    expect(v2.holderFlow.byBucket.cash).toMatchObject({ gross: null, net: null, yield: null });
    expect(v2.holderFlow.byBucket.burn!.gross).toBeCloseTo(year(5));
    expect(v2.multiples.mcapToHolderFlow.total).toBeNull();
  });

  it('a not_measured holders line makes the remainder null', () => {
    const { v2 } = run(`${holdersWithNm}  remainder: protocol\n`);
    expect(v2.protocol.remainder).toBe(true);
    expect(v2.protocol.annualized).toBeNull();
    expect(v2.protocol.lines[0].annualized).toBeNull();
    expect(v2.unreconciled.annualized).toBeNull();
  });

  it('a not_measured protocol line: protocol null, listed; the opex remainder and unreconciled null', () => {
    const block = `  revenue: [ { id: fees, metric: flow_usd.fees } ]
${BURN}  protocol: [ { id: treasury, metric: flow_usd.treasury }, { id: grants, not_measured: "grants not scanned" } ]
  remainder: operating_costs
`;
    const { v2 } = run(block);
    expect(v2.protocol.annualized).toBeNull();
    expect(v2.protocol.notMeasured).toEqual(['grants']);
    expect(v2.operatingCosts.annualized).toBeNull();
    expect(v2.unreconciled.annualized).toBeNull();
    expect(v2.ratios.payoutRatio).toEqual(expect.any(Number));
  });

  it('a not_measured operating cost: opex null, listed; unreconciled null', () => {
    const { v2 } = run(BASE.replace('operating_costs: [ { id: keepers, metric: flow_usd.keepers } ]', 'operating_costs: [ { id: keepers, metric: flow_usd.keepers }, { id: audits, not_measured: "audit costs not disclosed" } ]'));
    expect(v2.operatingCosts.annualized).toBeNull();
    expect(v2.operatingCosts.notMeasured).toEqual(['audits']);
    expect(v2.unreconciled.annualized).toBeNull();
    expect(v2.protocol.notMeasured).toEqual([]);
  });
});

describe('fix round 1: unreconciled is exactly 0 where the series coincide (M2)', () => {
  it.each(['aero', 'cake', 'crv', 'cvxcrv', 'link', 'sdcrv', 'sky', 'uni'])('%s: unreconciled === 0 on synthetic series', (id) => {
    const input = syntheticInput(repoAsset(id));
    const v2 = incomeStatementV2(input);
    expect(v2.unreconciled.annualized).toBe(0);
  });

  it('a real gap still shows (yCRV: revenue less YBS payouts and treasury; the toy: 0.5/day)', () => {
    const input = syntheticInput(repoAsset('ycrv'));
    const v2 = incomeStatementV2(input);
    expect(v2.unreconciled.annualized).not.toBe(0);
    expect(v2.unreconciled.annualized).toBeCloseTo(v2.revenue.annualized! - v2.holders.annualized! - v2.protocol.annualized!, 6);
    expect(run(BASE).v2.unreconciled.annualized).toBeCloseTo(year(0.5));
  });

  it('with a disclosed level: from totals', () => {
    const { v2 } = run(`  revenue: [ { id: business, disclosed: revenue_run_rate_usd } ]\n${BURN}  protocol: [ { id: treasury, metric: flow_usd.treasury } ]\n`, {
      levels: levels({ disclosed: [{ observedAt: '2026-01-01T00:00:00.000Z', value: 10_000 }] }),
    });
    expect(v2.unreconciled.annualized).toBeCloseTo(10_000 - year(5) - year(2));
  });
});

describe('fix round 1: a data gap is flagged apart from not_measured (M3)', () => {
  it('a measured cost with a missing day: payout on revenue flagged as a data gap, not as not measured', () => {
    const asset = toy(BASE);
    const lp = flat(20, 2);
    lp.delete(addDays(DAY, -3));
    const daily = new Map([
      ['flow_usd.fees', flat(20, 10)], ['flow_usd.lp', lp], ['flow_usd.burn', flat(20, 5)], ['flow_usd.treasury', flat(20, 2)], ['flow_usd.keepers', flat(20, 0.5)],
    ]);
    const input: ReportInput = { asset, day: DAY, daily, levels: levels() };
    const v2 = incomeStatementV2(input);
    expect(v2.grossProfit.annualized).toBeNull();
    expect(v2.ratios.payoutRatioBasis).toBe('revenue');
    expect(v2.flags).toContain('payout ratio on revenue: cost of revenue has a missing day');
    expect(v2.flags).not.toContain('payout ratio on revenue: cost of revenue not measured');
    expect(v2.flags.some((f) => f.startsWith('cost of revenue not measured'))).toBe(false);
  });
});

describe('fix round 1: provenance blind spots (M4)', () => {
  const def = (source: unknown, extra: object = {}) => ({ type: 'level', unit: 'usd', staleness_days: 1, source, ...extra }) as unknown as MetricDef;
  it('a derived metric inherits third_party when any input is third_party (given the asset metrics)', () => {
    const metrics: Record<string, MetricDef> = {
      'flow_usd.proxy': def({ type: 'defillama', slug: 'x', data_type: 'dailyRevenue' }),
      'flow_usd.burn': def({ type: 'transfer_flow' }),
      rate_proxy: def({ type: 'derived', name: 'flow_annualized', params: { metric: 'flow_usd.proxy', days: 91 } }),
      rate_net: def({ type: 'derived', name: 'flow_annualized', params: { metrics: ['flow_usd.burn', 'flow_usd.burn'], minus: ['flow_usd.proxy'], days: 91 } }),
      rate_burn: def({ type: 'derived', name: 'flow_annualized', params: { metric: 'flow_usd.burn', days: 91 } }),
      rate_of_rate: def({ type: 'derived', name: 'flow_annualized', params: { metric: 'rate_proxy', days: 91 } }),
    };
    expect(sourceTypeOf(metrics.rate_proxy, metrics)).toBe('third_party');
    expect(sourceTypeOf(metrics.rate_net, metrics)).toBe('third_party');
    expect(sourceTypeOf(metrics.rate_of_rate, metrics)).toBe('third_party');
    expect(sourceTypeOf(metrics.rate_burn, metrics)).toBe('derived');
    expect(sourceTypeOf(metrics.rate_proxy)).toBe('derived'); // without the map: the rung of the source itself
  });

  it('metric-level third-party cross_checks of statement lines are listed (section.id.cross_checks)', () => {
    const tp = (id: string) => {
      const input = syntheticInput(repoAsset(id));
      return incomeStatementV2(input).provenance.thirdParty;
    };
    // LIT's and VVV's were removed in Phase 3 R1; CRV's (llama.box, R7) stays.
    expect(tp('lit')).toEqual([]);
    expect(tp('vvv')).toEqual([]);
    expect(tp('crv')).toEqual(['below_line.vote_incentives', 'below_line.vote_incentives.cross_checks']);
  });
});

describe('fix round 1: shape (M1 volume, M6)', () => {
  // CAKE and UNI: volume not_measured since Phase 3 R1 (DefiLlama's gross fees removed); cvxCRV keeps the list form.
  it.each(['cvxcrv'])('%s: volume is v1 volume (annualized, growth, metrics)', (id) => {
    const input = syntheticInput(repoAsset(id));
    const v2 = incomeStatementV2(input);
    const metrics = input.asset.income_statement!.volume as string[];
    const sum = windowSum(input.daily, metrics, input.day, 91)!;
    expect(v2.volume).toEqual({ metrics, annualized: (sum * 365) / 91, growth: growthOf(input.daily, metrics, input.day, 91) });
  });

  it.each(['cvxcrv'])('%s: the list form output carries no notMeasured key (byte-identical)', (id) => {
    const v2 = incomeStatementV2(syntheticInput(repoAsset(id)));
    expect(Object.keys(v2.volume!)).toEqual(['metrics', 'annualized', 'growth']);
  });

  it.each(['cake', 'uni'])('%s: volume is not_measured with its reason, no figure (Phase 3 R1)', (id) => {
    const v2 = incomeStatementV2(syntheticInput(repoAsset(id)));
    expect(v2.volume).toMatchObject({ metrics: [], annualized: null, notMeasured: expect.stringContaining('DefiLlama removed (Phase 3 R1)') });
  });

  it('volume { not_measured } reads no metric and reports no figure, never 0 (Phase 3 Task 5)', () => {
    const block = `${BASE}  volume: { not_measured: "gross volume not measured" }\n`;
    const { v2 } = run(block);
    expect(v2.volume).toStrictEqual({
      metrics: [], annualized: null,
      growth: { current: null, prior: null, change: null, annualized: null, note: 'not measured' },
      notMeasured: 'gross volume not measured',
    });
    expect(Object.keys(v2.volume!)).toEqual(['metrics', 'annualized', 'growth', 'notMeasured']);
    expect(reportFlowMetrics(toy(block))).toEqual(reportFlowMetrics(toy(BASE)));
  });

  it('volume is null without a volume list', () => {
    expect(run(BASE).v2.volume).toBeNull();
  });

  it('dilution.tokensPerYear = emissions + releases (tokens a year)', () => {
    expect(run(BASE).v2.dilution.tokensPerYear).toBe(50);
    const input = syntheticInput(repoAsset('uni'));
    const v2 = incomeStatementV2(input);
    // UNI's Labs vest: rate 2M a year capped at what is approved (1.5M).
    expect(v2.dilution.releases).toEqual([{ id: 'labs_vest', tokensPerYear: 1_500_000, yield: 1_500_000 / 1_000_000_000 }]);
    expect(v2.yields.dilutionLines).toEqual(v2.dilution.releases);
    expect(v2.dilution.tokensPerYear).toBeCloseTo(10_000_000 + 1_500_000);
    expect(v2.dilution.tokensPerYear! / 1_000_000_000).toBeCloseTo(v2.yields.dilution!);
    expect(run(BASE, { levels: levels({ emissionRateAnnual: null }) }).v2.dilution.tokensPerYear).toBeNull();
  });

  it('holder-flow lines carry method and sourceTypes', () => {
    const { v2 } = run(`${BASE}  below_line:
    - { id: bribes, metric: flow_usd.bribes, to: holders, bucket: cash, haircut: 0, recipient_base: all, capture_rule: programmatic }
    - { id: other_bribes, to: holders, not_measured: "not scanned" }
`);
    const line = (id: string) => v2.holderFlow.lines.find((l) => l.id === id)!;
    // The toy's metrics have no source: entered by hand (disclosure).
    expect(line('burn')).toMatchObject({ method: 'measured', sourceTypes: ['disclosure'] });
    expect(line('bribes')).toMatchObject({ method: 'measured', sourceTypes: ['disclosure'] });
    expect(line('other_bribes')).toMatchObject({ method: 'not_measured', sourceTypes: [] });
    const hype = (() => {
      const input = syntheticInput(repoAsset('hype'));
      return incomeStatementV2(input);
    })();
    expect(hype.holderFlow.lines.find((l) => l.id === 'af_buyback')).toMatchObject({ method: 'measured', sourceTypes: ['third_party'] });
    expect(hype.holderFlow.lines.find((l) => l.id === 'reserve_yield_paid')).toMatchObject({ method: 'measured', sourceTypes: ['first_party_api'] });
  });

  it('IsV2 lists its keys in a fixed order (volume after belowLine-adjacent sections)', () => {
    const keys = Object.keys(run(BASE).v2 as IsV2);
    expect(keys).toEqual([
      'schema', 'day', 'windowDays', 'category', 'scope', 'revenue', 'costOfRevenue', 'grossProfit', 'holders', 'protocol', 'operatingCosts', 'unreconciled',
      'belowLine', 'holderFlow', 'volume', 'dilution', 'ratios', 'multiples', 'yields', 'perToken', 'priceBasis', 'checks', 'provenance', 'flags',
    ]);
  });
});
