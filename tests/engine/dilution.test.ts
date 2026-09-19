import { describe, expect, it } from 'vitest';
import { computeDrivers, type Drivers } from '../../src/drivers/compute.js';
import { EngineError } from '../../src/engine/errors.js';
import { getModule } from '../../src/engine/modules/registry.js';
import type { ModuleContext } from '../../src/engine/modules/types.js';
import { postHorizonSupply } from '../../src/engine/supply.js';
import { hypeObservations, loadFixture } from '../fixtures/contrast.js';
import { miniAsset, miniAssumptions } from '../helpers/assets.js';
import { AS_OF, miniObservations } from '../helpers/obs.js';

const asset = miniAsset();
const a = miniAssumptions().base;
const driversFor = (emission: number): Drivers => computeDrivers(asset, miniObservations({ emission }), AS_OF).drivers!;

describe('postHorizonSupply', () => {
  it('holds supply flat with no emissions', () => {
    const post = postHorizonSupply({ asset, drivers: driversFor(0), horizonYears: 1, supplyAtHorizon: 100 });
    expect(post.terminalEmission).toBe(0);
    expect(post.supplyAt(0)).toBe(100);
    expect(post.supplyAt(3.5)).toBe(100);
  });

  it('adds the last emission step each year and interpolates linearly inside a year', () => {
    const post = postHorizonSupply({ asset, drivers: driversFor(10), horizonYears: 1, supplyAtHorizon: 110 });
    expect(post.terminalEmission).toBe(10);
    expect(post.supplyAt(1)).toBeCloseTo(120, 12);
    expect(post.supplyAt(2.5)).toBeCloseTo(135, 12);
  });

  it('does not shrink supply for burn flows: holder_cashflow already values those dollars', () => {
    const drivers = driversFor(0);
    drivers.holderFlows[0].kind = 'burn';
    const post = postHorizonSupply({ asset, drivers, horizonYears: 1, supplyAtHorizon: 100 });
    expect(post.supplyAt(5)).toBe(100);
  });

  it('adds scheduled unlocks in the year they fall, on the circulating basis only', () => {
    const hype = loadFixture('hype');
    const list = hypeObservations(100).map((o) =>
      o.metricKey === 'scheduled_unlock_tokens' ? { ...o, observedAt: '2028-03-31T00:00:00.000Z' } : o, // 1.75 years out
    );
    const drivers = computeDrivers(hype, list, AS_OF).drivers!;
    const args = { asset: hype, drivers, horizonYears: 1, supplyAtHorizon: 300 };
    expect(postHorizonSupply(args).supplyAt(0.5)).toBeCloseTo(350, 9); // the unlock lands in the first year after H
    expect(postHorizonSupply(args).supplyAt(1)).toBeCloseTo(400, 9);
    expect(postHorizonSupply(args).supplyAt(2)).toBeCloseTo(400, 9);
    expect(postHorizonSupply({ ...args, basis: 'effective_total' }).supplyAt(2)).toBeCloseTo(300, 9);
  });
});

describe('holder_cashflow per-token discounting', () => {
  const m = getModule('holder_cashflow');
  const ctxFor = (drivers: Drivers, supplyAtHorizon: number, over: Partial<ModuleContext> = {}): ModuleContext => {
    const post = postHorizonSupply({ asset, drivers, horizonYears: 1, supplyAtHorizon });
    return {
      instanceId: 'hc', params: {}, drivers, assumptions: a, horizonYears: 1, supplyAtHorizon, priceAtHorizon: 10,
      stakingYieldAtHorizon: 0, supplyAfterHorizon: post.supplyAt, terminalEmissionRate: post.terminalEmission, ...over,
    };
  };

  it('equals the 1.1.0 value when nothing dilutes after the horizon', () => {
    const r = m.compute(ctxFor(driversFor(0), 100));
    expect(r.valuePerToken).toBeCloseTo(10, 10); // 100 / 0.10 / 100
    expect(r.breakdown.aggregate_pv_usd).toBeCloseTo(1000, 8);
    expect(r.breakdown.net_dilution_terminal).toBe(0);
    expect(r.breakdown.per_token_growth_terminal).toBe(0);
    expect(r.breakdown.supply_path).toEqual([100, 100, 100, 100, 100, 100]);
  });

  it('matches the hand-derived value for constant emissions', () => {
    // Flat 100 USD per year; supply 110 at the horizon growing by 10 per year; r = 10 percent; g = 0.
    //   explicit: 100/115/1.1 + 100/125/1.1^2 + 100/135/1.1^3 + 100/145/1.1^4 + 100/155/1.1^5 = 2.8798385...
    //   terminal: delta = 10/160 = 0.0625; g_pt = 1/1.0625 - 1 = -1/17;
    //             (100/155) * (1 + g_pt) / (0.1 - g_pt) / 1.1^5 = 2.3738927...
    const r = m.compute(ctxFor(driversFor(10), 110));
    expect(r.valuePerToken).toBeCloseTo(5.253731257665621, 10);
    expect(r.breakdown.net_dilution_terminal).toBeCloseTo(0.0625, 12);
    expect(r.breakdown.per_token_growth_terminal).toBeCloseTo(-1 / 17, 12);
    expect(r.breakdown.supply_path).toEqual([110, 120, 130, 140, 150, 160]);
    const flows = r.breakdown.flows as Record<string, { explicit_pv_per_token: number; terminal_pv_per_token: number; explicit_pv_usd: number }>;
    expect(flows.fees.explicit_pv_per_token).toBeCloseTo(2.879838505229187, 10);
    expect(flows.fees.terminal_pv_per_token).toBeCloseTo(2.3738927524364346, 10);
    expect(flows.fees.explicit_pv_usd).toBeCloseTo(2.879838505229187 * 110, 8);
  });

  it('values a burn flow exactly like a fee flow: burns are cash flow, not extra shrinkage', () => {
    const burning = driversFor(10);
    burning.holderFlows[0].kind = 'burn';
    expect(m.compute(ctxFor(burning, 110)).valuePerToken).toBeCloseTo(5.253731257665621, 10);
  });

  it('throws when the discount rate does not exceed terminal per-token growth', () => {
    const c = ctxFor(driversFor(0), 100, { assumptions: { ...a, terminal_growth: 0.1 } });
    expect(() => m.compute(c)).toThrow(EngineError);
    expect(() => m.compute(c)).toThrow(/per-token growth/);
  });

  it('lets dilution rescue a discount rate equal to aggregate growth, because per-token growth is lower', () => {
    const c = ctxFor(driversFor(10), 110, { assumptions: { ...a, terminal_growth: 0.1 } });
    expect(Number.isFinite(m.compute(c).valuePerToken)).toBe(true);
  });
});
