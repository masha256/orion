import { describe, expect, it } from 'vitest';
import { computeDrivers, type DriverValue } from '../../src/drivers/compute.js';
import { emissionAt } from '../../src/engine/modules/voteIncentives.js';
import { getModule, moduleTypes } from '../../src/engine/modules/registry.js';
import type { ModuleContext } from '../../src/engine/modules/types.js';
import { miniAsset, miniAssumptions } from '../helpers/assets.js';
import { AS_OF, miniObservations } from '../helpers/obs.js';

const dv = (value: number): DriverValue => ({ value, provenance: 'api', derived: false, observedAt: AS_OF });
const yearsOn = (years: number) => new Date(new Date(AS_OF).getTime() + years * 365 * 86_400_000).toISOString();

function ctx(opts: {
  assumptions?: Record<string, number>;
  params?: Record<string, unknown>;
  schedule?: { from: string; value: number }[];
  incentives?: number;
  price?: number;
  priceAtHorizon?: number;
  supplyAtHorizon?: number;
  horizonYears?: number;
} = {}): ModuleContext {
  const drivers = computeDrivers(miniAsset(), miniObservations(), AS_OF).drivers!;
  drivers.extra = { vote_incentive_run_rate_usd: dv(opts.incentives ?? 1000) };
  drivers.emissionSchedule = opts.schedule ?? [{ from: AS_OF, value: 100 }];
  drivers.price = dv(opts.price ?? 100);
  return {
    instanceId: 'bribes',
    params: opts.params ?? { years: 1 },
    drivers,
    assumptions: { ...miniAssumptions().base, incentive_efficiency_drift: 0, incentive_discount_rate: 0.25, ...opts.assumptions },
    horizonYears: opts.horizonYears ?? 1,
    supplyAtHorizon: opts.supplyAtHorizon ?? 1000,
    priceAtHorizon: opts.priceAtHorizon ?? 100,
    stakingYieldAtHorizon: 0,
    supplyAfterHorizon: () => opts.supplyAtHorizon ?? 1000,
    terminalEmissionRate: 100,
  };
}

describe('vote_incentives', () => {
  const m = getModule('vote_incentives');

  it('is a registered component with its own assumptions and one extra metric', () => {
    expect(moduleTypes()).toContain('vote_incentives');
    expect(m.allowedKinds).toEqual(['component']);
    expect(m.assumptionKeys('bribes', {}, [])).toEqual(['incentive_efficiency_drift', 'incentive_discount_rate']);
    expect(m.requiredExtra({})).toEqual(['vote_incentive_run_rate_usd']);
    expect(m.requiredExtra({ metric: 'bribes_usd' })).toEqual(['bribes_usd']);
  });

  it('validates its parameters', () => {
    expect(m.validateParams({})).toEqual([]);
    expect(m.validateParams({ metric: 'x', years: 10, post_horizon_emission_decay: 0.159 })).toEqual([]);
    expect(m.validateParams({ metric: '' })).toEqual(['metric must be a metric key']);
    expect(m.validateParams({ years: 0 })).toEqual(['years must be an integer from 1 to 30']);
    expect(m.validateParams({ years: 2.5 })).toEqual(['years must be an integer from 1 to 30']);
    expect(m.validateParams({ years: 31 })).toEqual(['years must be an integer from 1 to 30']);
    expect(m.validateParams({ post_horizon_emission_decay: 1 })).toEqual(['post_horizon_emission_decay must be a number in [0, 1)']);
    expect(m.validateParams({ post_horizon_emission_decay: -0.1 })).toEqual(['post_horizon_emission_decay must be a number in [0, 1)']);
  });

  it('is a plain discounted annuity when emissions, price, and drift are flat', () => {
    // 1000 USD a year, 3 years at 25 percent: 1000 * (1/1.25 + 1/1.5625 + 1/1.953125) = 1952, over 1000 tokens.
    const r = m.compute(ctx({ params: { years: 3 } }));
    expect(r.valuePerToken).toBeCloseTo((1000 / 1.25 + 1000 / 1.5625 + 1000 / 1.953125) / 1000, 12);
    expect(r.breakdown).toMatchObject({ incentives_run_rate_usd: 1000, emission_rate_now: 100, price_ratio: 1, years_valued: 3 });
  });

  it('matches a hand-computed value with a coded cut, decay, price, and drift', () => {
    // H = 1. Steps: 100 now, 80 from 1.2 years. Decay 0.5 a year past the last step. Two years valued.
    // Year 1 midpoint 1.5: E = 80 (0 whole years past 1.2), ratio 0.8. Year 2 midpoint 2.5: E = 80 * 0.5, ratio 0.4.
    // Price ratio 200 / 100 = 2. Drift 0.1: (1.1)^1.5 and (1.1)^2.5. r = 0.25.
    const c = ctx({
      params: { years: 2, post_horizon_emission_decay: 0.5 },
      schedule: [{ from: AS_OF, value: 100 }, { from: yearsOn(1.2), value: 80 }],
      priceAtHorizon: 200,
      assumptions: { incentive_efficiency_drift: 0.1 },
    });
    const y1 = 1000 * 0.8 * 2 * Math.pow(1.1, 1.5);
    const y2 = 1000 * 0.4 * 2 * Math.pow(1.1, 2.5);
    const r = m.compute(c);
    expect(r.valuePerToken).toBeCloseTo((y1 / 1.25 + y2 / 1.5625) / 1000, 10);
    expect(r.breakdown.first_year_incentives_usd).toBeCloseTo(y1, 9);
  });

  it('reads the step in force, the future step, and the decay past it', () => {
    const c = ctx({ schedule: [{ from: yearsOn(-0.5), value: 100 }, { from: yearsOn(1), value: 80 }] });
    expect(emissionAt(c, 0, 0.2)).toBe(100);
    expect(emissionAt(c, 0.99, 0.2)).toBe(100);
    expect(emissionAt(c, 1, 0.2)).toBe(80);
    expect(emissionAt(c, 1.99, 0.2)).toBe(80);
    expect(emissionAt(c, 2, 0.2)).toBeCloseTo(64, 12);
    expect(emissionAt(c, 3.5, 0.2)).toBeCloseTo(51.2, 12);
    expect(emissionAt(c, 3.5, 0)).toBe(80);
  });

  it('moves the right way with each input', () => {
    const base = m.compute(ctx({ params: { years: 5 } })).valuePerToken;
    expect(m.compute(ctx({ params: { years: 5, post_horizon_emission_decay: 0.159 } })).valuePerToken).toBeLessThan(base);
    expect(m.compute(ctx({ params: { years: 5 }, assumptions: { incentive_discount_rate: 0.4 } })).valuePerToken).toBeLessThan(base);
    expect(m.compute(ctx({ params: { years: 5 }, assumptions: { incentive_efficiency_drift: 0.1 } })).valuePerToken).toBeGreaterThan(base);
    expect(m.compute(ctx({ params: { years: 5 }, priceAtHorizon: 120 })).valuePerToken).toBeGreaterThan(base);
    expect(m.compute(ctx({ params: { years: 5 }, supplyAtHorizon: 2000 })).valuePerToken).toBeCloseTo(base / 2, 12);
    expect(m.compute(ctx({ params: { years: 5 }, incentives: 0 })).valuePerToken).toBe(0);
  });

  it('refuses what it cannot value', () => {
    expect(() => m.compute(ctx({ assumptions: { incentive_discount_rate: 0 } }))).toThrow(/incentive_discount_rate must be positive/);
    expect(() => m.compute(ctx({ assumptions: { incentive_efficiency_drift: -1 } }))).toThrow(/above -1/);
    expect(() => m.compute(ctx({ schedule: [{ from: AS_OF, value: 0 }] }))).toThrow(/positive emission rate/);
    expect(() => m.compute(ctx({ price: 0 }))).toThrow(/positive spot price/);
    expect(() => m.compute(ctx({ incentives: -1 }))).toThrow(/must not be negative/);
    const noExtra = ctx();
    noExtra.drivers.extra = {};
    expect(() => m.compute(noExtra)).toThrow(/needs extra driver "vote_incentive_run_rate_usd"/);
    // 1,000,000 USD a year over 1000 tokens at a price of 100: far above half the price.
    expect(() => m.compute(ctx({ incentives: 1_000_000 }))).toThrow(/percent of the horizon price/);
  });
});
