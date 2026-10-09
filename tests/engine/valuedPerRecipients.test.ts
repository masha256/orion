import { describe, expect, it } from 'vitest';
import { parseAssetYaml } from '../../src/config/load.js';
import { computeDrivers } from '../../src/drivers/compute.js';
import { runEngine } from '../../src/engine/run.js';
import { MINI_ASSET_YAML, miniAssumptions } from '../helpers/assets.js';
import { AS_OF, miniObservations } from '../helpers/obs.js';

const FLOW = '- { id: fees, kind: fee_share, capture_rule: contractual, recipient_base: all, metric: flow_usd.fees }';
const STAKED = '- { id: fees, kind: fee_share, capture_rule: contractual, recipient_base: staked, metric: flow_usd.fees }';
const PER_RECIPIENTS = '- { id: fees, kind: fee_share, capture_rule: contractual, recipient_base: staked, metric: flow_usd.fees, valued_per: recipients }';
const WITH_FM = (yaml: string) =>
  yaml
    .replace('  - { id: hc, type: holder_cashflow, kind: estimate, weight: 1 }', '  - { id: hc, type: holder_cashflow, kind: estimate, weight: 0.5 }\n  - { id: fm, type: forward_multiple, kind: estimate, weight: 0.5, params: { basis: holder_flow } }')
    .replace('  staked_ratio_horizon: { min: 0.05, max: 0.95 }', '  staked_ratio_horizon: { min: 0.05, max: 0.95 }\n  multiple.fm: { min: 1, max: 50 }\n  regime_multiplier: { min: 0.5, max: 1.5 }');

const load = (flow: string, fm = false) => {
  const yaml = MINI_ASSET_YAML.replace(FLOW, flow);
  expect(yaml).not.toBe(MINI_ASSET_YAML);
  return parseAssetYaml(fm ? WITH_FM(yaml) : yaml).config;
};
const value = (flow: string, staked: number, fm = false) => {
  const asset = load(flow, fm);
  const drivers = computeDrivers(asset, miniObservations({ staked }), AS_OF).drivers!;
  const a = miniAssumptions(fm ? { 'multiple.fm': 10, regime_multiplier: 1 } : {});
  return { drivers, out: runEngine({ asset, drivers, assumptions: a }).horizons['12m'] };
};

describe('holder flows valued per recipients', () => {
  it('only goes with recipient_base staked', () => {
    expect(() => load(PER_RECIPIENTS.replace('recipient_base: staked', 'recipient_base: all'))).toThrow(/valued per recipients only with recipient_base staked/);
  });

  it('carries the staked share now on the driver, and 1 for every other flow', () => {
    expect(value(PER_RECIPIENTS, 25).drivers.holderFlows[0].valuedOverShare).toBe(0.25);
    expect(value(STAKED, 25).drivers.holderFlows[0].valuedOverShare).toBe(1);
  });

  it('values the cash per staked token: the per-supply value divided by the staked share, in both estimate modules', () => {
    for (const fm of [false, true]) {
      const plain = value(STAKED, 25, fm).out;
      const per = value(PER_RECIPIENTS, 25, fm).out;
      expect(per.expectedTarget / plain.expectedTarget).toBeCloseTo(4, 9);
      for (const id of fm ? ['hc', 'fm'] : ['hc']) expect(per.modules[id].value / plain.modules[id].value).toBeCloseTo(4, 9);
    }
    // The staked amount moves the per-staked value only through the share; the per-supply value does not move at all.
    expect(value(STAKED, 50).out.expectedTarget).toBeCloseTo(value(STAKED, 25).out.expectedTarget, 12);
    expect(value(PER_RECIPIENTS, 50).out.expectedTarget * 2).toBeCloseTo(value(PER_RECIPIENTS, 25).out.expectedTarget, 9);
  });

  it('shows the share in the breakdowns, and leaves a plain flow\'s breakdown as before', () => {
    const per = value(PER_RECIPIENTS, 25, true).out.modules;
    expect((per.hc.breakdown.flows as Record<string, Record<string, unknown>>).fees.valued_over_share).toBe(0.25);
    expect(per.fm.breakdown.valued_per_recipients).toEqual({ fees: 0.25 });
    const plain = value(STAKED, 25, true).out.modules;
    expect((plain.hc.breakdown.flows as Record<string, Record<string, unknown>>).fees).not.toHaveProperty('valued_over_share');
    expect(plain.fm.breakdown).not.toHaveProperty('valued_per_recipients');
  });

  it('refuses to value a flow per recipients when nothing is staked', () => {
    const asset = load(PER_RECIPIENTS);
    const drivers = computeDrivers(asset, miniObservations({ staked: 0 }), AS_OF).drivers!;
    expect(() => runEngine({ asset, drivers, assumptions: miniAssumptions() })).toThrow(/valued per recipients but the staked share is 0/);
  });
});
