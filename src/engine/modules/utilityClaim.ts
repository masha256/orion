import { EngineError } from '../errors.js';
import { need } from '../paths.js';
import type { ModuleContext, ValuationModule } from './types.js';

type Basis = 'market' | 'intrinsic';
const isBasis = (x: unknown): x is Basis => x === 'market' || x === 'intrinsic';
const num = (params: Record<string, unknown>, key: string, fallback: number): number =>
  typeof params[key] === 'number' ? (params[key] as number) : fallback;

function extra(ctx: ModuleContext, key: string): number {
  const v = ctx.drivers.extra[key];
  if (!v) throw new EngineError(`utility_claim needs extra driver "${key}"`);
  return v.value;
}

export const utilityClaim: ValuationModule = {
  type: 'utility_claim',
  allowedKinds: ['component'],

  validateParams(params) {
    const errors: string[] = [];
    if (!isBasis(params.diem_value_basis)) errors.push('diem_value_basis must be "market" or "intrinsic"');
    for (const key of ['mint_base_rate', 'mint_curve_k', 'mint_curve_power', 'credit_usd_per_year', 'years']) {
      if (params[key] !== undefined && typeof params[key] !== 'number') errors.push(`${key} must be a number`);
    }
    return errors;
  },

  assumptionKeys(_id, params) {
    const keys = ['diem_target_supply_growth', 'diem_discount_rate'];
    if (params.diem_value_basis === 'intrinsic') keys.push('diem_utilization');
    return keys;
  },

  requiredExtra(params) {
    const keys = ['diem_supply', 'diem_target_supply', 'diem_locked_yield_share'];
    if (params.diem_value_basis !== 'intrinsic') keys.push('diem_price_usd');
    return keys;
  },

  compute(ctx) {
    const p = ctx.params;
    const basis: Basis = isBasis(p.diem_value_basis) ? p.diem_value_basis : 'market';
    const N = num(p, 'years', 5);
    const H = ctx.horizonYears;
    const g = need(ctx.assumptions, 'diem_target_supply_growth');
    const r = need(ctx.assumptions, 'diem_discount_rate');
    if (!(r > 0)) throw new EngineError('diem_discount_rate must be positive');

    const supply = extra(ctx, 'diem_supply');
    const target0 = extra(ctx, 'diem_target_supply');
    const lockedShare = extra(ctx, 'diem_locked_yield_share');
    const fill = target0 > 0 ? Math.min(1, supply / target0) : 0;

    const mintRate =
      num(p, 'mint_base_rate', 90) * Math.exp(num(p, 'mint_curve_k', 2) * Math.pow(fill, num(p, 'mint_curve_power', 3)));
    const diemValue =
      basis === 'market'
        ? extra(ctx, 'diem_price_usd')
        : (num(p, 'credit_usd_per_year', 365) * need(ctx.assumptions, 'diem_utilization')) / r;

    const haircutPerYear = mintRate * ctx.stakingYieldAtHorizon * (1 - lockedShare) * ctx.priceAtHorizon;
    let annuity = 0;
    for (let t = 1; t <= N; t++) annuity += 1 / Math.pow(1 + r, t);
    const cost = haircutPerYear * annuity;
    const net = Math.max(0, diemValue - cost);

    let pv = 0;
    let issued = 0;
    for (let t = 1; t <= N; t++) {
      const issuance = fill * target0 * (Math.pow(1 + g, H + t) - Math.pow(1 + g, H + t - 1));
      issued += issuance;
      pv += (issuance * net) / Math.pow(1 + r, t);
    }

    return {
      valuePerToken: pv / ctx.supplyAtHorizon,
      breakdown: {
        diem_value_basis: basis,
        diem_value_usd: diemValue,
        mint_rate_vvv_per_diem: mintRate,
        cost_of_locking_usd: cost,
        net_value_per_diem_usd: net,
        fill_ratio: fill,
        diem_issued_over_explicit_years: issued,
        aggregate_pv_usd: pv,
        note: 'Values future DIEM issuance only. Existing DIEM is value already distributed to its minters.',
      },
    };
  },
};
