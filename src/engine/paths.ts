import type { Drivers, HolderFlowDriver } from '../drivers/compute.js';
import type { ScenarioAssumptions } from '../types.js';
import { EngineError } from './errors.js';

export function need(a: ScenarioAssumptions, key: string): number {
  const v = a[key];
  if (v === undefined || !Number.isFinite(v)) throw new EngineError(`missing assumption: ${key}`);
  return v;
}

export function growthInYear(y: number, a: ScenarioAssumptions): number {
  const g1 = need(a, 'rev_growth_y1');
  const gT = need(a, 'terminal_growth');
  const fade = need(a, 'growth_fade_years');
  if (y <= 1) return g1;
  if (fade <= 0) return gT;
  return g1 + (gT - g1) * Math.min(1, (y - 1) / fade);
}

export function revenueAt(tau: number, r0: number, a: ScenarioAssumptions): number {
  if (tau <= 0) return r0;
  const whole = Math.floor(tau);
  let r = r0;
  for (let y = 1; y <= whole; y++) r *= 1 + growthInYear(y, a);
  const frac = tau - whole;
  if (frac > 0) r *= Math.pow(1 + growthInYear(whole + 1, a), frac);
  return r;
}

export function captureRateAt(tau: number, c0: number, cT: number, rampYears: number): number {
  if (tau <= 0) return c0;
  if (rampYears <= 0) return cT;
  return c0 + (cT - c0) * Math.min(1, tau / rampYears);
}

/**
 * A holder flow per token of the supply it is valued over: all of it, or the recipients' share (the staked ratio now).
 * A flow paid only to stakers grows and shrinks with the staked amount (the unstaked share goes elsewhere), so the
 * cash per staked token is held at today's share rather than at the horizon assumption.
 */
export function perValuedToken(usd: number, supply: number, flow: HolderFlowDriver): number {
  if (!(flow.valuedOverShare > 0)) throw new EngineError(`flow ${flow.id} is valued per recipients but the staked share is ${flow.valuedOverShare}`);
  return usd / (supply * flow.valuedOverShare);
}

/** Annualized USD run-rate of one holder flow at time tau. */
export function flowUsdAt(tau: number, flow: HolderFlowDriver, drivers: Drivers, a: ScenarioAssumptions): number {
  const revenue = revenueAt(tau, drivers.revenueRunRate.value, a);
  const rate = captureRateAt(
    tau,
    flow.captureRate,
    need(a, `capture_rate_terminal.${flow.id}`),
    need(a, `capture_ramp_years.${flow.id}`),
  );
  return revenue * rate;
}
