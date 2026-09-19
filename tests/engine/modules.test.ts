import { describe, expect, it } from 'vitest';
import { computeDrivers } from '../../src/drivers/compute.js';
import { EngineError } from '../../src/engine/errors.js';
import { getModule, moduleTypes } from '../../src/engine/modules/registry.js';
import type { ModuleContext } from '../../src/engine/modules/types.js';
import { miniAsset, miniAssumptions } from '../helpers/assets.js';
import { AS_OF, miniObservations } from '../helpers/obs.js';

function ctx(over: Partial<ModuleContext> = {}): ModuleContext {
  return {
    instanceId: 'm',
    params: {},
    drivers: computeDrivers(miniAsset(), miniObservations(), AS_OF).drivers!,
    assumptions: miniAssumptions().base,
    horizonYears: 1,
    supplyAtHorizon: 100,
    priceAtHorizon: 10,
    stakingYieldAtHorizon: 0,
    ...over,
  };
}

describe('registry', () => {
  it('knows the shared modules and rejects unknown types', () => {
    expect(moduleTypes()).toEqual(expect.arrayContaining(['holder_cashflow', 'forward_multiple']));
    expect(() => getModule('nope')).toThrow(/unknown module/);
  });
});

describe('holder_cashflow', () => {
  const m = getModule('holder_cashflow');

  it('values a flat 100 per year flow at 10 percent as a 1000 perpetuity', () => {
    const r = m.compute(ctx());
    expect(r.valuePerToken).toBeCloseTo(10, 6);
    expect(r.breakdown.aggregate_pv_usd).toBeCloseTo(1000, 4);
  });

  it('adds the capture-rule premium to the discount rate', () => {
    const c = ctx({ assumptions: { ...miniAssumptions().base, discount_premium_discretionary: 0.1 } });
    c.drivers.holderFlows[0].captureRule = 'discretionary';
    expect(m.compute(c).valuePerToken).toBeCloseTo(5, 6); // 100 / 0.20 / 100
  });

  it('throws when the discount rate does not exceed terminal growth', () => {
    const c = ctx({ assumptions: { ...miniAssumptions().base, terminal_growth: 0.1 } });
    expect(() => m.compute(c)).toThrow(EngineError);
  });

  it('declares premium keys only for the rules in use', () => {
    expect(m.assumptionKeys('hc', {}, [{ id: 'fees', captureRule: 'contractual' }])).not.toContain('discount_premium_discretionary');
    expect(m.assumptionKeys('hc', {}, [{ id: 'burn', captureRule: 'discretionary' }])).toContain('discount_premium_discretionary');
  });
});

describe('forward_multiple', () => {
  const m = getModule('forward_multiple');
  const a = { ...miniAssumptions().base, 'multiple.m': 10, regime_multiplier: 0.5 };

  it('applies multiple and regime to forward revenue', () => {
    const r = m.compute(ctx({ params: { basis: 'revenue' }, assumptions: a }));
    expect(r.valuePerToken).toBeCloseTo((1000 * 10 * 0.5) / 100, 9);
  });

  it('can use holder flow as the basis', () => {
    const r = m.compute(ctx({ params: { basis: 'holder_flow' }, assumptions: a }));
    expect(r.valuePerToken).toBeCloseTo((100 * 10 * 0.5) / 100, 9);
  });

  it('validates params and names its multiple key after the instance', () => {
    expect(m.validateParams({})).not.toEqual([]);
    expect(m.validateParams({ basis: 'revenue' })).toEqual([]);
    expect(m.assumptionKeys('fm_rev', { basis: 'revenue' }, [])).toContain('multiple.fm_rev');
  });
});
