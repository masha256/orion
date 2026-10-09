import { EngineError } from '../errors.js';
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
    for (const f of ctx.drivers.holderFlows) {
      if (!(f.valuedOverShare > 0)) throw new EngineError(`flow ${f.id} is valued per recipients but the staked share is ${f.valuedOverShare}`);
    }
    const mid = ctx.horizonYears + 0.5;
    const basis =
      basisKind === 'revenue'
        ? revenueAt(mid, ctx.drivers.revenueRunRate.value, ctx.assumptions)
        : // A flow valued per recipients counts as if paid on every token (divided by its share; exact for share 1).
          ctx.drivers.holderFlows.reduce((s, f) => s + flowUsdAt(mid, f, ctx.drivers, ctx.assumptions) / f.valuedOverShare, 0);
    const multiple = need(ctx.assumptions, `multiple.${ctx.instanceId}`);
    const regime = need(ctx.assumptions, 'regime_multiplier');
    const aggregate = basis * multiple * regime;
    return {
      valuePerToken: aggregate / ctx.supplyAtHorizon,
      breakdown: {
        basis: basisKind,
        market_convention: ctx.params.market_convention === true,
        forward_basis_usd: basis,
        ...(basisKind === 'holder_flow' && ctx.drivers.holderFlows.some((f) => f.valuedOverShare !== 1)
          ? { valued_per_recipients: Object.fromEntries(ctx.drivers.holderFlows.map((f) => [f.id, f.valuedOverShare])) }
          : {}),
        multiple,
        regime_multiplier: regime,
        aggregate_value_usd: aggregate,
        supply_at_horizon: ctx.supplyAtHorizon,
      },
    };
  },
};
