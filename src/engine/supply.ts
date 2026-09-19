import type { AssetConfig } from '../config/schema.js';
import type { Drivers } from '../drivers/compute.js';
import type { ScheduleStep } from '../drivers/select.js';
import { DAYS_PER_YEAR, MS_PER_DAY, type ScenarioAssumptions } from '../types.js';
import { EngineError } from './errors.js';
import { flowUsdAt } from './paths.js';

export interface SupplyArgs {
  asset: AssetConfig;
  drivers: Drivers;
  assumptions: ScenarioAssumptions;
  horizonYears: number;
  targetPrice: number;
  /** Forecast on this basis instead of the asset's own. Used for figures defined on effective supply. */
  basis?: AssetConfig['supply_basis'];
}

export function yearsBetween(asOf: string, iso: string): number {
  return (new Date(iso).getTime() - new Date(asOf).getTime()) / (MS_PER_DAY * DAYS_PER_YEAR);
}

export function emissionsBetween(steps: ScheduleStep[], asOf: string, t0: number, t1: number): number {
  const pts = steps.map((s) => ({ t: yearsBetween(asOf, s.from), rate: s.value })).sort((x, y) => x.t - y.t);
  let total = 0;
  for (let i = 0; i < pts.length; i++) {
    const start = Math.max(pts[i].t, t0);
    const end = Math.min(i + 1 < pts.length ? pts[i + 1].t : Infinity, t1);
    if (end > start) total += pts[i].rate * (end - start);
  }
  return total;
}

export function forecastSupply(args: SupplyArgs): number {
  const { asset, drivers, assumptions, horizonYears: H, targetPrice } = args;
  const circulating = (args.basis ?? asset.supply_basis) === 'circulating';
  const spot = drivers.price.value;

  let supply: number;
  if (circulating) {
    if (!drivers.circulatingSupply) throw new EngineError('circulating supply is required for the circulating basis');
    supply = drivers.circulatingSupply.value;
  } else {
    supply = drivers.effectiveSupply.value;
  }

  supply += emissionsBetween(drivers.emissionSchedule, drivers.asOf, 0, H);

  if (circulating) {
    for (const u of drivers.scheduledUnlocks) {
      const t = yearsBetween(drivers.asOf, u.at);
      if (t > 0 && t <= H) supply += u.tokens;
    }
  }

  const removing = drivers.holderFlows.filter((f) => f.kind === 'burn' || (circulating && f.kind === 'buy_and_hold'));
  if (removing.length > 0) {
    const steps = Math.max(1, Math.round(12 * H));
    const dt = H / steps;
    for (let i = 0; i < steps; i++) {
      const tau = (i + 0.5) * dt;
      const price = spot + (targetPrice - spot) * (tau / H);
      if (!(price > 0)) throw new EngineError('price path must stay positive');
      for (const f of removing) supply -= (flowUsdAt(tau, f, drivers, assumptions) / price) * dt;
    }
  }

  if (!(supply > 0)) throw new EngineError('forecast supply is not positive');
  return supply;
}
