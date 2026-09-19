import { EngineError } from '../errors.js';
import { flowUsdAt, need } from '../paths.js';
import { captureKeys, discountKeys, discountRateFor, REVENUE_KEYS } from './keys.js';
import type { ValuationModule } from './types.js';

function years(params: Record<string, unknown>): number {
  return typeof params.years === 'number' ? params.years : 5;
}

export const holderCashflow: ValuationModule = {
  type: 'holder_cashflow',
  allowedKinds: ['estimate'],

  validateParams(params) {
    const errors: string[] = [];
    if (params.years !== undefined && !(typeof params.years === 'number' && Number.isInteger(params.years) && params.years >= 1)) {
      errors.push('years must be a positive integer');
    }
    return errors;
  },

  assumptionKeys(_id, _params, flows) {
    return [...REVENUE_KEYS, ...captureKeys(flows), ...discountKeys(flows)];
  },

  requiredExtra() {
    return [];
  },

  compute(ctx) {
    const N = years(ctx.params);
    const H = ctx.horizonYears;
    const g = need(ctx.assumptions, 'terminal_growth');
    let aggregate = 0;
    const flows: Record<string, unknown> = {};

    for (const f of ctx.drivers.holderFlows) {
      const r = discountRateFor(f.captureRule, ctx.assumptions);
      if (r <= g) throw new EngineError(`discount rate ${r} must exceed terminal growth ${g} (flow ${f.id})`);
      let pv = 0;
      let last = 0;
      for (let t = 1; t <= N; t++) {
        last = flowUsdAt(H + t - 0.5, f, ctx.drivers, ctx.assumptions);
        pv += last / Math.pow(1 + r, t);
      }
      const terminal = (last * (1 + g)) / (r - g) / Math.pow(1 + r, N);
      aggregate += pv + terminal;
      flows[f.id] = {
        discount_rate: r,
        capture_rule: f.captureRule,
        recipient_base: f.recipientBase,
        explicit_pv_usd: pv,
        terminal_pv_usd: terminal,
      };
    }

    return {
      valuePerToken: aggregate / ctx.supplyAtHorizon,
      breakdown: {
        aggregate_pv_usd: aggregate,
        supply_at_horizon: ctx.supplyAtHorizon,
        explicit_years: N,
        flows,
        note: 'Aggregate holder-flow value divided by total forecast supply, whatever the recipient base.',
      },
    };
  },
};
