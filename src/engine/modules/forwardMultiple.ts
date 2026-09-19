import { flowUsdAt, need, revenueAt } from '../paths.js';
import { captureKeys, REVENUE_KEYS } from './keys.js';
import type { ValuationModule } from './types.js';

type Basis = 'revenue' | 'holder_flow';
const isBasis = (x: unknown): x is Basis => x === 'revenue' || x === 'holder_flow';

export const forwardMultiple: ValuationModule = {
  type: 'forward_multiple',
  allowedKinds: ['estimate'],

  validateParams(params) {
    const errors: string[] = [];
    if (!isBasis(params.basis)) errors.push('basis must be "revenue" or "holder_flow"');
    if (params.market_convention !== undefined && typeof params.market_convention !== 'boolean') {
      errors.push('market_convention must be a boolean');
    }
    return errors;
  },

  assumptionKeys(instanceId, params, flows) {
    const keys = [...REVENUE_KEYS, `multiple.${instanceId}`, 'regime_multiplier'];
    if (params.basis === 'holder_flow') keys.push(...captureKeys(flows));
    return keys;
  },

  requiredExtra() {
    return [];
  },

  compute(ctx) {
    const basisKind: Basis = isBasis(ctx.params.basis) ? ctx.params.basis : 'revenue';
    const mid = ctx.horizonYears + 0.5;
    const basis =
      basisKind === 'revenue'
        ? revenueAt(mid, ctx.drivers.revenueRunRate.value, ctx.assumptions)
        : ctx.drivers.holderFlows.reduce((s, f) => s + flowUsdAt(mid, f, ctx.drivers, ctx.assumptions), 0);
    const multiple = need(ctx.assumptions, `multiple.${ctx.instanceId}`);
    const regime = need(ctx.assumptions, 'regime_multiplier');
    const aggregate = basis * multiple * regime;
    return {
      valuePerToken: aggregate / ctx.supplyAtHorizon,
      breakdown: {
        basis: basisKind,
        market_convention: ctx.params.market_convention === true,
        forward_basis_usd: basis,
        multiple,
        regime_multiplier: regime,
        aggregate_value_usd: aggregate,
        supply_at_horizon: ctx.supplyAtHorizon,
      },
    };
  },
};
