import { describe, expect, it } from 'vitest';
import { parseAssetYaml } from '../../src/config/load.js';
import type { MetricDef } from '../../src/config/schema.js';
import { addDays } from '../../src/ingest/time.js';
import { holderYieldReport, type ReportInput, type ReportLevels } from '../../src/report/holderYield.js';
import { incomeStatementV2, listingBar } from '../../src/report/incomeStatement.js';
import { reportFlowMetrics } from '../../src/report/load.js';
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
holder_flows:
  - { id: burn, kind: burn, capture_rule: programmatic, recipient_base: all, metric: flow_usd.burn }
reporting:
  window_days: ${W}
  haircuts: { burn: 0 }
  income: { lines: [ { id: burn, to: holders, metric: flow_usd.burn } ] }
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
  const v1 = holderYieldReport(input);
  return { v1, v2: incomeStatementV2(input, v1) };
}

const year = (perDay: number) => (perDay * W * 365) / W;

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
    const v2 = incomeStatementV2(input, holderYieldReport(input));
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
    const { v2, v1 } = run(BASE, { levels: levels({ asOf: '2026-01-21T23:59:59.999Z' }) });
    expect(v2.perToken.circulatingSupply).toBe(500);
    expect(v2.perToken.totalSupply).toBe(1000);
    expect(v2.perToken.supplyAsOf).toBe('2026-01-21T23:59:59.999Z');
    expect(v2.perToken.revenue).toBeCloseTo(year(10) / 500);
    expect(v2.perToken.grossProfit).toBeCloseTo(year(8) / 500);
    expect(v2.perToken.holderFlow.total).toBeCloseTo(year(5) / 500);
    expect(v2.perToken.holderFlow.byBucket).toEqual({ burn: expect.closeTo(year(5) / 500), hold: null, cash: null });
    expect(v2.perToken.dilution).toBeCloseTo((v1.yields.dilution! * v1.fdv!) / 500);
    expect(v2.perToken.perTokenFdv.revenue).toBeCloseTo(year(10) / 1000);
    expect(v2.perToken.perTokenFdv.holderFlow.total).toBeCloseTo(year(5) / 1000);
    // The multiples at Orion's day-end price: market cap 1000 (2 x 500).
    expect(v2.multiples.mcapToRevenue).toBeCloseTo(1000 / year(10));
    expect(v2.multiples.mcapToHolderFlow.burn).toBeCloseTo(1000 / year(5));
  });

  it('priceBasis names the day-end price, its source and day', () => {
    const asset = repoAsset('crv');
    const input = syntheticInput(asset);
    const v2 = incomeStatementV2(input, holderYieldReport(input));
    expect(v2.priceBasis).toEqual({
      price: 1.7, metric: 'price_usd', sourceType: 'market_data', source: 'market_data:coingecko', day: '2026-11-02', asOf: '2026-11-03T23:59:59.999Z',
      flows: "each flow day's USD at that day's price (the stored value)",
    });
  });

  it('dilution and yields are v1\'s; checks are empty and provenance.basis is config', () => {
    const { v1, v2 } = run(BASE);
    expect(v2.yields).toEqual(v1.yields);
    expect(v2.dilution).toMatchObject({ pct: v1.yields.dilution, emissionsPerYear: 50, supply: v1.supply });
    expect(v2.checks).toEqual([]);
    expect(v2.provenance.basis).toBe('config');
    expect(v2.provenance.methods).toEqual({ measured: 1, derived: 0, disclosed: 0 });
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
      return incomeStatementV2(input, holderYieldReport(input)).provenance.thirdParty;
    };
    expect(tp('hype')).toEqual(['revenue.trading', 'holders.af_buyback']);
    expect(tp('pump')).toEqual(['revenue.protocol']);
    expect(tp('aero')).toEqual(['revenue.fees', 'holders.voter_fees']);
    expect(tp('vvv')).toEqual(['revenue.business.cross_check']);
    expect(tp('crv')).toEqual(['below_line.vote_incentives']);
    for (const id of ['cake', 'cvxcrv', 'link', 'lit', 'sdcrv', 'sky', 'uni', 'ycrv']) expect(tp(id), id).toEqual([]);
  });

  it('provenance.sources names each statement series by rung, never a full URL', () => {
    const input = syntheticInput(repoAsset('lit'));
    const v2 = incomeStatementV2(input, holderYieldReport(input));
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

describe('reportFlowMetrics with income_statement', () => {
  it('adds no series for the 13 assets (the default report day does not move), in v1 order', () => {
    for (const id of ALL_ASSETS) {
      const asset = repoAsset(id);
      expect(reportFlowMetrics(asset), id).toEqual(reportFlowMetrics({ ...asset, income_statement: undefined }));
    }
  });

  it('reads a series only the income statement names', () => {
    const asset = toy(`${BASE}  below_line: [ { id: bribes, metric: flow_usd.bribes, to: holders, bucket: cash, haircut: 0.05, recipient_base: staked, capture_rule: programmatic } ]\n`);
    expect(reportFlowMetrics(asset)).toEqual(['flow_usd.burn', 'flow_usd.fees', 'flow_usd.lp', 'flow_usd.treasury', 'flow_usd.keepers', 'flow_usd.bribes']);
  });
});
