import type { AssetConfig, ModuleInstanceDef } from '../config/schema.js';
import type { Drivers, HolderFlowDriver } from '../drivers/compute.js';
import type { ScenarioAssumptions } from '../types.js';
import { EngineError } from './errors.js';
import { emissionAtDrivers, incentiveReturnBase, num, priceBasisOf } from './modules/voteIncentives.js';
import { flowUsdAt, need } from './paths.js';

/** Midpoint steps per year when the cash paid during the horizon is summed. */
const STEPS_PER_YEAR = 12;

export type RecipientBase = 'all' | 'staked' | 'locked';

/** One stream of cash a holder receives during the horizon: what it is, whom it pays, and how much per receiving token. */
export interface CashStream {
  id: string;
  source: 'holder_flow' | 'vote_incentives';
  recipient_base: RecipientBase;
  usd: number;
  usd_per_token: number;
}

export interface StakedCash {
  /** USD per receiving token paid during the horizon, all streams. */
  usdPerToken: number;
  streams: CashStream[];
}

/**
 * Cash a staked (or locking) holder receives DURING the horizon. The estimate modules value the flows from the
 * horizon on (that is the token's price then); the payouts before it go to the holder and appear nowhere else, so the
 * staked total return adds them. Counted: holder flows of kind fee_share (cash paid out; burns and buybacks act
 * through the price and supply, and counting them would double-count), and vote incentives where the asset opts in
 * (`params.staked_return`: who collects them). Each stream follows the same growth path the valuation uses, summed at
 * monthly midpoints, and is divided by its recipients at that time: total supply ("all"), staked supply (the share
 * now for a flow valued per recipients, else moving from today's ratio to staked_ratio_horizon), or locked supply now.
 */
export function stakedCashDuringHorizon(input: {
  asset: AssetConfig;
  drivers: Drivers;
  assumptions: ScenarioAssumptions;
  horizonYears: number;
  /** Total supply forecast at the horizon. */
  effectiveAtHorizon: number;
  targetPrice: number;
  instances: ModuleInstanceDef[];
}): StakedCash {
  const { drivers, assumptions: a, horizonYears: H } = input;
  const steps = Math.max(1, Math.round(H * STEPS_PER_YEAR));
  const dt = H / steps;
  const eff0 = drivers.totalSupply.value;
  const effAt = (tau: number) => eff0 + (input.effectiveAtHorizon - eff0) * (tau / H);
  const stakedNow = eff0 > 0 ? drivers.stakedSupply.value / eff0 : 0;
  const stakedH = need(a, 'staked_ratio_horizon');
  // Locked supply now (the locked ratio of total supply), else the staked supply.
  const lockedNow = drivers.lockedRatio ? drivers.lockedRatio.value * eff0 : drivers.stakedSupply.value;

  const recipients = (base: RecipientBase, tau: number, flow?: HolderFlowDriver): number => {
    if (base === 'all') return effAt(tau);
    if (base === 'locked') return lockedNow;
    const share = flow && flow.valuedOverShare !== 1 ? flow.valuedOverShare : stakedNow + (stakedH - stakedNow) * (tau / H);
    return effAt(tau) * share;
  };

  const streams: CashStream[] = [];
  const add = (id: string, source: CashStream['source'], base: RecipientBase, at: (tau: number) => number, flow?: HolderFlowDriver) => {
    let usd = 0;
    let perToken = 0;
    for (let i = 0; i < steps; i++) {
      const tau = (i + 0.5) * dt;
      const paid = at(tau) * dt;
      const n = recipients(base, tau, flow);
      if (!(n > 0)) throw new EngineError(`no recipients for the ${id} cash during the horizon (${base} supply is ${n})`);
      usd += paid;
      perToken += paid / n;
    }
    streams.push({ id, source, recipient_base: base, usd, usd_per_token: perToken });
  };

  for (const f of drivers.holderFlows) {
    if (f.kind !== 'fee_share') continue;
    add(f.id, 'holder_flow', f.recipientBase, (tau) => flowUsdAt(tau, f, drivers, a), f);
  }

  for (const def of input.instances) {
    if (def.type !== 'vote_incentives') continue;
    const base = incentiveReturnBase(def.params);
    if (base === null) continue;
    const metric = typeof def.params.metric === 'string' ? def.params.metric : 'vote_incentive_run_rate_usd';
    const b0 = drivers.extra[metric];
    if (!b0) throw new EngineError(`vote_incentives needs extra driver "${metric}"`);
    const decay = num(def.params, 'post_horizon_emission_decay', 0);
    const e0 = emissionAtDrivers(drivers, 0, decay);
    if (!(e0 > 0)) throw new EngineError('vote_incentives needs a positive emission rate now');
    const drift = need(a, 'incentive_efficiency_drift');
    const spot = drivers.price.value;
    // On the horizon basis the price moves from spot to the target across the horizon.
    const priceRatio = (tau: number) => (priceBasisOf(def.params) === 'spot' ? 1 : (spot + (input.targetPrice - spot) * (tau / H)) / spot);
    add(def.id, 'vote_incentives', base, (tau) => b0.value * (emissionAtDrivers(drivers, tau, decay) / e0) * priceRatio(tau) * Math.pow(1 + drift, tau));
  }

  return { usdPerToken: streams.reduce((s, x) => s + x.usd_per_token, 0), streams };
}
