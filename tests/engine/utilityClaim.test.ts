import { describe, expect, it } from 'vitest';
import { computeDrivers, type DriverValue } from '../../src/drivers/compute.js';
import { getModule } from '../../src/engine/modules/registry.js';
import type { ModuleContext } from '../../src/engine/modules/types.js';
import { miniAsset, miniAssumptions } from '../helpers/assets.js';
import { AS_OF, miniObservations } from '../helpers/obs.js';

const dv = (value: number): DriverValue => ({ value, provenance: 'onchain', derived: false, observedAt: AS_OF });

function ctx(assumptions: Record<string, number>, params: Record<string, unknown>): ModuleContext {
  const drivers = computeDrivers(miniAsset(), miniObservations(), AS_OF).drivers!;
  drivers.extra = {
    diem_supply: dv(500),
    diem_target_supply: dv(1000),
    diem_locked_yield_share: dv(0.8),
    diem_price_usd: dv(10),
  };
  return {
    instanceId: 'diem', params, drivers,
    assumptions: { ...miniAssumptions().base, ...assumptions },
    horizonYears: 1, supplyAtHorizon: 1000, priceAtHorizon: 5, stakingYieldAtHorizon: 0.1,
  };
}

describe('utility_claim', () => {
  const m = getModule('utility_claim');
  const params = { diem_value_basis: 'market', mint_base_rate: 2, mint_curve_k: 0, years: 1 };

  it('is a component and needs its extra drivers', () => {
    expect(m.allowedKinds).toEqual(['component']);
    expect(m.requiredExtra(params)).toEqual(
      expect.arrayContaining(['diem_supply', 'diem_target_supply', 'diem_locked_yield_share', 'diem_price_usd']),
    );
    expect(m.requiredExtra({ diem_value_basis: 'intrinsic' })).not.toContain('diem_price_usd');
  });

  it('is worth nothing when the target supply does not grow', () => {
    expect(m.compute(ctx({ diem_target_supply_growth: 0, diem_discount_rate: 0.25 }, params)).valuePerToken).toBe(0);
  });

  it('matches the hand-computed value', () => {
    // fill 0.5, target doubles yearly: issuance in year 1 after H=1 is 0.5*1000*(4-2) = 1000 DIEM
    // mint_rate 2, haircut = 2*0.1*0.2*5 = 0.2/yr, cost = 0.2/1.25 = 0.16, net = 9.84
    // value = 1000 * 9.84 / 1.25 / 1000 = 7.872
    const r = m.compute(ctx({ diem_target_supply_growth: 1, diem_discount_rate: 0.25 }, params));
    expect(r.valuePerToken).toBeCloseTo(7.872, 9);
  });

  it('supports an intrinsic DIEM value', () => {
    const p = { ...params, diem_value_basis: 'intrinsic', credit_usd_per_year: 365 };
    const r = m.compute(ctx({ diem_target_supply_growth: 1, diem_discount_rate: 0.25, diem_utilization: 0.5 }, p));
    // diem_value = 365*0.5/0.25 = 730 ; net = 729.84 ; value = 1000*729.84/1.25/1000
    expect(r.valuePerToken).toBeCloseTo(729.84 / 1.25, 9);
    expect(m.assumptionKeys('diem', p, [])).toContain('diem_utilization');
  });

  it('never goes negative when locking costs more than DIEM is worth', () => {
    const r = m.compute({ ...ctx({ diem_target_supply_growth: 1, diem_discount_rate: 0.25 }, params), priceAtHorizon: 1e6 });
    expect(r.valuePerToken).toBe(0);
  });
});
