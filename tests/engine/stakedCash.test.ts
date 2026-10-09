import { describe, expect, it } from 'vitest';
import { parseAssetYaml } from '../../src/config/load.js';
import { computeDrivers } from '../../src/drivers/compute.js';
import { validateAssetModules } from '../../src/engine/requirements.js';
import { runEngine } from '../../src/engine/run.js';
import { MINI_ASSET_YAML, miniAssumptions } from '../helpers/assets.js';
import { AS_OF, miniObservations } from '../helpers/obs.js';

const FLOW = '- { id: fees, kind: fee_share, capture_rule: contractual, recipient_base: all, metric: flow_usd.fees }';
const withFlow = (flow: string) => {
  expect(MINI_ASSET_YAML).toContain(FLOW);
  const yaml = MINI_ASSET_YAML.replace(FLOW, flow);
  return parseAssetYaml(yaml).config;
};
const h12 = (flow: string, staked = 25, over: Partial<Record<string, number>> = {}) => {
  const asset = withFlow(flow);
  const drivers = computeDrivers(asset, miniObservations({ staked }), AS_OF).drivers!;
  return runEngine({ asset, drivers, assumptions: miniAssumptions(over) }).horizons['12m'];
};

// The mini world: 100 tokens, revenue 1000 a year, capture 10 percent -> 100 USD a year of fee share, price 10.
describe('cash paid to stakers during the horizon (engine 1.3.0)', () => {
  it('divides a flow paid to all holders by the whole supply', () => {
    expect(h12(FLOW).stakedCashPerToken).toBeCloseTo(1, 9);
  });

  it('divides a staked flow by staked supply moving from today to staked_ratio_horizon', () => {
    const staked = FLOW.replace('recipient_base: all', 'recipient_base: staked');
    // From 25 percent staked now to 25 percent at the horizon: 100 / 25.
    expect(h12(staked, 25, { staked_ratio_horizon: 0.25 }).stakedCashPerToken).toBeCloseTo(4, 9);
    // From 25 to 50 percent, linearly: the integral of 100 / (100 (0.25 + 0.25 t)) dt over a year = 4 ln 2.
    expect(h12(staked, 25, { staked_ratio_horizon: 0.5 }).stakedCashPerToken).toBeCloseTo(4 * Math.log(2), 2); // monthly midpoints: within 1e-3 of the integral
  });

  it('holds a flow valued per recipients at the staked share now, as the valuation does', () => {
    const per = FLOW.replace('recipient_base: all', 'recipient_base: staked, valued_per: recipients');
    expect(h12(per, 25, { staked_ratio_horizon: 0.9 }).stakedCashPerToken).toBeCloseTo(4, 9);
  });

  it('follows the growth path the valuation uses', () => {
    // 20 percent growth in year one, continuously compounded within the year: integral of 100 * 1.2^t dt = 20 / ln 1.2.
    expect(h12(FLOW, 25, { rev_growth_y1: 0.2 }).stakedCashPerToken).toBeCloseTo(0.2 / Math.log(1.2) * 1, 3);
  });

  it('leaves burns and buybacks out: they act through price and supply', () => {
    const burn = FLOW.replace('kind: fee_share', 'kind: burn');
    const h = h12(burn);
    expect(h.stakedCashPerToken).toBe(0);
    expect(h.stakedTotalReturnPct).toBeCloseTo(h.upsidePct, 9);
  });

  it('adds the cash to the staked total return, not to the target', () => {
    const plain = h12(FLOW);
    expect(plain.expectedTarget).toBeCloseTo(10, 6);
    expect(plain.upsidePct).toBeCloseTo(0, 4);
    expect(plain.stakedTotalReturnPct).toBeCloseTo(10, 4);
  });
});

describe('vote incentives in the staked total return', () => {
  const VI_YAML = (ret: string) =>
    MINI_ASSET_YAML.replace('flow_usd.fees: { type: flow', 'vote_incentive_run_rate_usd: { type: level, unit: usd, staleness_days: 30 }\n  flow_usd.fees: { type: flow')
      .replace(
        '  - { id: hc, type: holder_cashflow, kind: estimate, weight: 1 }',
        `  - { id: hc, type: holder_cashflow, kind: estimate, weight: 1 }\n  - { id: vi, type: vote_incentives, kind: component, params: { years: 10, price_basis: spot${ret} } }`,
      )
      .replace('  staked_ratio_horizon: { min: 0.05, max: 0.95 }', '  staked_ratio_horizon: { min: 0.05, max: 0.95 }\n  incentive_efficiency_drift: { min: -0.5, max: 0.5 }\n  incentive_discount_rate: { min: 0.05, max: 0.9 }');

  const run = (ret: string) => {
    const asset = parseAssetYaml(VI_YAML(ret)).config;
    const list = [...miniObservations({ staked: 25, emission: 10 })];
    list.push({ ...list[0], id: 9999, metricKey: 'vote_incentive_run_rate_usd', value: 50 });
    const drivers = computeDrivers(asset, list, AS_OF).drivers!;
    return runEngine({ asset, drivers, assumptions: miniAssumptions({ incentive_efficiency_drift: 0, incentive_discount_rate: 0.5 }) }).horizons['12m'];
  };

  it('are left out unless the asset says who collects them', () => {
    const h = run('');
    expect(h.scenarios.base.stakedCashStreams.map((s) => s.id)).toEqual(['fees']);
  });

  it('are counted per receiving token when the asset opts in', () => {
    const h = run(', staked_return: staked');
    const vi = h.scenarios.base.stakedCashStreams.find((s) => s.id === 'vi')!;
    expect(vi).toMatchObject({ source: 'vote_incentives', recipient_base: 'staked' });
    // 50 a year at a flat emission rate and spot basis: 50 USD over the year.
    expect(vi.usd).toBeCloseTo(50, 6);
    expect(h.stakedCashPerToken).toBeGreaterThan(run('').stakedCashPerToken);
  });

  it('refuses an unknown collector', () => {
    expect(validateAssetModules(parseAssetYaml(VI_YAML(', staked_return: voters')).config)).toContain(
      'modules.vi.params: staked_return must be "all", "staked" or "locked"',
    );
    expect(validateAssetModules(parseAssetYaml(VI_YAML(', staked_return: locked')).config)).toEqual([]);
  });
});
