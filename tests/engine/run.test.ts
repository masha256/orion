import { describe, expect, it } from 'vitest';
import { parseAssetYaml } from '../../src/config/load.js';
import { computeDrivers } from '../../src/drivers/compute.js';
import { runEngine } from '../../src/engine/run.js';
import { ENGINE_VERSION } from '../../src/engine/version.js';
import { canonicalJson } from '../../src/util/canonical.js';
import { MINI_ASSET_YAML, miniAsset, miniAssumptions } from '../helpers/assets.js';
import { AS_OF, miniObservations, obs, type MiniOverrides } from '../helpers/obs.js';

function run(obsOver: MiniOverrides = {}, assumeOver: Partial<Record<string, number>> = {}, asset = miniAsset()) {
  const drivers = computeDrivers(asset, miniObservations(obsOver), AS_OF).drivers!;
  return runEngine({ asset, drivers, assumptions: miniAssumptions(assumeOver) });
}

describe('runEngine', () => {
  it('values the flat mini asset at its perpetuity value in every scenario', () => {
    const out = run();
    expect(out.engineVersion).toBe(ENGINE_VERSION);
    expect(out.converged).toBe(true);
    const h = out.horizons['12m'];
    expect(h.expectedTarget).toBeCloseTo(10, 6);
    expect(h.upsidePct).toBeCloseTo(0, 4);
    expect(h.scenarios.base.supplyAtHorizon).toBeCloseTo(100, 9);
    expect(h.modules.hc.value).toBeCloseTo(10, 6);
    expect(h.dispersion).toBe(0);
    expect(h.stakedTotalReturnPct).toBeCloseTo(0, 4);
  });

  it('is deterministic', () => {
    expect(canonicalJson(run())).toBe(canonicalJson(run()));
  });

  it('lowers the per-token target when emissions rise', () => {
    const diluted = run({ emission: 10 }).horizons['12m'];
    expect(diluted.expectedTarget).toBeCloseTo(1000 / 110, 6);
    // staker APR = 10 / (0.5 * 110); total return = (target/spot) * (1 + y) - 1
    const y = 10 / (0.5 * 110);
    expect(diluted.stakedTotalReturnPct).toBeCloseTo(((1000 / 110 / 10) * (1 + y) - 1) * 100, 6);
  });

  it('raises the target when growth rises', () => {
    expect(run({}, { rev_growth_y1: 0.5 }).horizons['12m'].expectedTarget).toBeGreaterThan(10);
  });

  it('weights scenarios by probability', () => {
    const asset = miniAsset();
    const drivers = computeDrivers(asset, miniObservations(), AS_OF).drivers!;
    const values = miniAssumptions();
    values.bull.discount_rate_base = 0.05; // bull target = 100 / 0.05 / 100 = 20
    const h = runEngine({ asset, drivers, assumptions: values }).horizons['12m'];
    expect(h.scenarios.bull.target).toBeCloseTo(20, 6);
    expect(h.expectedTarget).toBeCloseTo(0.25 * 10 + 0.5 * 10 + 0.25 * 20, 6);
  });

  it('converges on a burn asset where supply depends on the target', () => {
    const asset = miniAsset();
    asset.holder_flows[0].kind = 'burn';
    const out = run({ price: 1, revenue: 12000, supply: 100000, staked: 50000, flowAnnual: 1200 }, {}, asset);
    const s = out.horizons['12m'].scenarios.base;
    expect(s.converged).toBe(true);
    expect(s.iterations).toBeGreaterThan(1);
    expect(s.supplyAtHorizon).toBeLessThan(100000);
  });

  it('blends two estimates, reports dispersion, and leaves holder_cashflow value untouched by regime', () => {
    const yaml = MINI_ASSET_YAML
      .replace('  - { id: hc, type: holder_cashflow, kind: estimate, weight: 1 }',
        '  - { id: hc, type: holder_cashflow, kind: estimate, weight: 0.5 }\n  - { id: fm, type: forward_multiple, kind: estimate, weight: 0.5, params: { basis: revenue } }')
      .replace('assumptions:', 'assumptions:\n  multiple.fm: { min: 0, max: 100 }\n  regime_multiplier: { min: 0.1, max: 3 }');
    const asset = parseAssetYaml(yaml).config;
    const lo = run({}, { 'multiple.fm': 2, regime_multiplier: 1 }, asset).horizons['12m'];
    // hc = 10, fm = 1000 * 2 * 1 / 100 = 20 -> blend 15, dispersion (20 - 10) / 15
    expect(lo.expectedTarget).toBeCloseTo(15, 6);
    expect(lo.dispersion).toBeCloseTo(10 / 15, 6);
    const hi = run({}, { 'multiple.fm': 2, regime_multiplier: 2 }, asset).horizons['12m'];
    expect(hi.modules.fm.value).toBeCloseTo(40, 6);
    expect(hi.modules.hc.breakdown.aggregate_pv_usd).toBeCloseTo(lo.modules.hc.breakdown.aggregate_pv_usd as number, 6);
  });

  it('measures staking yield against effective supply on a circulating-basis asset', () => {
    const asset = miniAsset();
    asset.supply_basis = 'circulating';
    asset.metrics.circulating_supply = { ...asset.metrics.effective_supply };
    const list = [...miniObservations({ emission: 10 }), obs('circulating_supply', 40, '2026-06-29')];
    const drivers = computeDrivers(asset, list, AS_OF).drivers!;
    const s = runEngine({ asset, drivers, assumptions: miniAssumptions() }).horizons['12m'].scenarios.base;
    // circulating at H = 40 + 10 emitted = 50; effective at H = 100 + 10 = 110 (a fee_share flow
    // burns nothing). staked_ratio_horizon is a share of EFFECTIVE supply, so
    // y = 10 emitted * share 1 / (0.5 * 110), not / (0.5 * 50).
    expect(s.supplyAtHorizon).toBeCloseTo(50, 9);
    expect(s.stakingYield).toBeCloseTo(10 / (0.5 * 110), 9);
  });

  it('leaves the staking yield of an effective_total asset alone', () => {
    const s = run({ emission: 10 }).horizons['12m'].scenarios.base;
    expect(s.supplyAtHorizon).toBeCloseTo(110, 9);
    expect(s.stakingYield).toBeCloseTo(10 / (0.5 * 110), 9);
  });

  it('emits total-return variants in extras', () => {
    const yaml = MINI_ASSET_YAML
      .replace('holder_flows:', '  lock_share: { type: level, unit: ratio, staleness_days: 90 }\nholder_flows:')
      + '\ntotal_return_variants:\n  - { id: locked_total_return_pct, yield_multiplier_metric: lock_share }\n';
    const asset = parseAssetYaml(yaml).config;
    const list = [...miniObservations({ emission: 10 })];
    list.push({ ...list[0], id: 9999, metricKey: 'lock_share', value: 0.8 });
    const drivers = computeDrivers(asset, list, AS_OF).drivers!;
    const h = runEngine({ asset, drivers, assumptions: miniAssumptions() }).horizons['12m'];
    const y = (10 / (0.5 * 110)) * 0.8;
    expect(h.extras.locked_total_return_pct).toBeCloseTo(((1000 / 110 / 10) * (1 + y) - 1) * 100, 6);
  });
});
