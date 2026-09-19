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
    const supplyAtHorizon = ctx.supplyAtHorizon;

    // Per-token discounting: each year's flow is divided by the supply forecast for that year, so
    // emissions after the horizon dilute the claim instead of being ignored.
    const supplyPath = Array.from({ length: N + 1 }, (_, n) => ctx.supplyAfterHorizon(n));
    const delta = ctx.terminalEmissionRate / supplyPath[N];
    const gPerToken = (1 + g) / (1 + delta) - 1;

    let value = 0;
    const flows: Record<string, unknown> = {};
    for (const f of ctx.drivers.holderFlows) {
      const r = discountRateFor(f.captureRule, ctx.assumptions);
      if (r <= gPerToken) {
        throw new EngineError(`discount rate ${r} must exceed terminal per-token growth ${gPerToken} (flow ${f.id})`);
      }
      let pv = 0;
      let last = 0;
      for (let t = 1; t <= N; t++) {
        last = flowUsdAt(H + t - 0.5, f, ctx.drivers, ctx.assumptions) / ctx.supplyAfterHorizon(t - 0.5);
        pv += last / Math.pow(1 + r, t);
      }
      const terminal = (last * (1 + gPerToken)) / (r - gPerToken) / Math.pow(1 + r, N);
      value += pv + terminal;
      flows[f.id] = {
        discount_rate: r,
        capture_rule: f.captureRule,
        recipient_base: f.recipientBase,
        explicit_pv_per_token: pv,
        terminal_pv_per_token: terminal,
        explicit_pv_usd: pv * supplyAtHorizon,
        terminal_pv_usd: terminal * supplyAtHorizon,
      };
    }

    return {
      valuePerToken: value,
      breakdown: {
        aggregate_pv_usd: value * supplyAtHorizon,
        supply_at_horizon: supplyAtHorizon,
        explicit_years: N,
        net_dilution_terminal: delta,
        per_token_growth_terminal: gPerToken,
        supply_path: supplyPath,
        flows,
        note:
          'Per-token holder flows, discounted. Supply after the horizon follows supply_path (emissions and ' +
          'unlocks; burns are valued as cash flow, not counted again as shrinkage), whatever the recipient base. ' +
          'The *_usd figures are the per-token values times supply at the horizon.',
      },
    };
  },
};
