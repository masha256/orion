import { yearsBetween } from '../supply.js';
import { EngineError } from '../errors.js';
import { need } from '../paths.js';
import type { ModuleContext, ValuationModule } from './types.js';

const DEFAULT_METRIC = 'vote_incentive_run_rate_usd';
const DEFAULT_YEARS = 10;
/** Above this share of the horizon price the component is mostly pricing itself; refuse rather than report it. */
const MAX_SHARE_OF_PRICE = 0.5;

const num = (params: Record<string, unknown>, key: string, fallback: number): number =>
  typeof params[key] === 'number' ? (params[key] as number) : fallback;
const metricOf = (params: Record<string, unknown>): string =>
  typeof params.metric === 'string' ? params.metric : DEFAULT_METRIC;

/**
 * Emissions per year in force `tau` years from as-of: the schedule step in force then; past the last step's date, that
 * step reduced by `decay` for every whole year since it (CRV: a coded 2^(-1/4) cut each year, about 15.9 percent).
 */
export function emissionAt(ctx: ModuleContext, tau: number, decay: number): number {
  const asOf = ctx.drivers.asOf;
  const steps = ctx.drivers.emissionSchedule
    .map((s) => ({ t: yearsBetween(asOf, s.from), rate: s.value }))
    .sort((a, b) => a.t - b.t);
  if (steps.length === 0) return ctx.drivers.emissionRateNow.value;
  let i = 0;
  while (i + 1 < steps.length && steps[i + 1].t <= tau) i++;
  const last = steps.length - 1;
  if (i < last || tau < steps[last].t) return steps[i].rate;
  return steps[last].rate * Math.pow(1 - decay, Math.floor(tau - steps[last].t));
}

/**
 * Vote incentives (bribes) paid to the asset's voters by third parties buying votes on where its emissions go. Not
 * revenue: their size tracks the dollar value of the emissions being directed, not the protocol's fees. So the run rate
 * scales with emissions and with the token price, plus a drift for how much a vote buyer pays per dollar of emissions
 * directed. Valued as a component (added on top of the blend, as VVV's DIEM): N years of incentives after the horizon,
 * each at its year's midpoint, discounted at its own rate and divided by supply at the horizon.
 */
export const voteIncentives: ValuationModule = {
  type: 'vote_incentives',
  allowedKinds: ['component'],

  validateParams(params) {
    const errors: string[] = [];
    if (params.metric !== undefined && (typeof params.metric !== 'string' || params.metric === '')) errors.push('metric must be a metric key');
    if (params.years !== undefined) {
      const y = params.years;
      if (typeof y !== 'number' || !Number.isInteger(y) || y < 1 || y > 30) errors.push('years must be an integer from 1 to 30');
    }
    if (params.post_horizon_emission_decay !== undefined) {
      const d = params.post_horizon_emission_decay;
      if (typeof d !== 'number' || !(d >= 0 && d < 1)) errors.push('post_horizon_emission_decay must be a number in [0, 1)');
    }
    return errors;
  },

  assumptionKeys() {
    return ['incentive_efficiency_drift', 'incentive_discount_rate'];
  },

  requiredExtra(params) {
    return [metricOf(params)];
  },

  compute(ctx) {
    const p = ctx.params;
    const metric = metricOf(p);
    const N = num(p, 'years', DEFAULT_YEARS);
    const decay = num(p, 'post_horizon_emission_decay', 0);
    const H = ctx.horizonYears;
    const drift = need(ctx.assumptions, 'incentive_efficiency_drift');
    const r = need(ctx.assumptions, 'incentive_discount_rate');
    if (!(r > 0)) throw new EngineError('incentive_discount_rate must be positive');
    if (!(drift > -1)) throw new EngineError('incentive_efficiency_drift must be above -1');

    const b0 = ctx.drivers.extra[metric];
    if (!b0) throw new EngineError(`vote_incentives needs extra driver "${metric}"`);
    if (!(b0.value >= 0)) throw new EngineError(`${metric} must not be negative`);
    const e0 = emissionAt(ctx, 0, decay);
    if (!(e0 > 0)) throw new EngineError('vote_incentives needs a positive emission rate now');
    const p0 = ctx.drivers.price.value;
    if (!(p0 > 0)) throw new EngineError('vote_incentives needs a positive spot price');
    const priceRatio = ctx.priceAtHorizon / p0;

    let pv = 0;
    const years: { t: number; emission_ratio: number; incentives_usd: number }[] = [];
    for (let t = 1; t <= N; t++) {
      const m = H + t - 0.5;
      const emissionRatio = emissionAt(ctx, m, decay) / e0;
      const incentives = b0.value * emissionRatio * priceRatio * Math.pow(1 + drift, m);
      pv += incentives / Math.pow(1 + r, t);
      years.push({ t, emission_ratio: emissionRatio, incentives_usd: incentives });
    }
    const valuePerToken = pv / ctx.supplyAtHorizon;
    if (ctx.priceAtHorizon > 0 && valuePerToken / ctx.priceAtHorizon > MAX_SHARE_OF_PRICE) {
      throw new EngineError(
        `vote_incentives would be ${(100 * valuePerToken / ctx.priceAtHorizon).toFixed(0)} percent of the horizon price; ` +
          `above ${100 * MAX_SHARE_OF_PRICE} percent the component is mostly pricing itself`,
      );
    }

    return {
      valuePerToken,
      breakdown: {
        metric,
        incentives_run_rate_usd: b0.value,
        emission_rate_now: e0,
        price_ratio: priceRatio,
        years_valued: N,
        post_horizon_emission_decay: decay,
        first_year_incentives_usd: years[0]?.incentives_usd ?? 0,
        aggregate_pv_usd: pv,
        note: 'Third-party payments for votes on emissions, not revenue: scaled by emissions and price, not by fees.',
      },
    };
  },
};
