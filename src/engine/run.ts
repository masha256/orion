import type { AssetConfig, ModuleInstanceDef, ModuleKind } from '../config/schema.js';
import type { Drivers } from '../drivers/compute.js';
import {
  HORIZON_YEARS, HORIZONS, SCENARIOS, type AssumptionValues, type Horizon, type Scenario, type ScenarioAssumptions,
} from '../types.js';
import { EngineError } from './errors.js';
import { getModule } from './modules/registry.js';
import type { ModuleResult, ValuationModule } from './modules/types.js';
import { need } from './paths.js';
import { emissionsBetween, forecastSupply } from './supply.js';
import { ENGINE_VERSION } from './version.js';

const MAX_ITERATIONS = 20;
const TOLERANCE = 0.001;

export interface EngineInput {
  asset: AssetConfig;
  drivers: Drivers;
  assumptions: AssumptionValues;
}
export interface ScenarioOutput {
  target: number;
  probability: number;
  supplyAtHorizon: number;
  stakingYield: number;
  iterations: number;
  converged: boolean;
  dispersion: number;
  modules: Record<string, ModuleResult>;
}
export interface ModuleSummary {
  type: string;
  kind: ModuleKind;
  weight: number | null;
  value: number;
  byScenario: Record<Scenario, number>;
  breakdown: Record<string, unknown>;
}
export interface HorizonOutput {
  expectedTarget: number;
  upsidePct: number;
  scenarios: Record<Scenario, ScenarioOutput>;
  modules: Record<string, ModuleSummary>;
  dispersion: number;
  stakedTotalReturnPct: number;
  extras: Record<string, number>;
}
export interface EngineOutput {
  engineVersion: string;
  asOf: string;
  spot: number;
  converged: boolean;
  horizons: Record<Horizon, HorizonOutput>;
}

interface Instance {
  def: ModuleInstanceDef;
  impl: ValuationModule;
}

function dispersionOf(estimates: { weight: number; value: number }[]): number {
  if (estimates.length === 0) return 0;
  const blended = estimates.reduce((s, e) => s + e.weight * e.value, 0);
  if (!(blended > 0)) return 0;
  const values = estimates.map((e) => e.value);
  return (Math.max(...values) - Math.min(...values)) / blended;
}

function solveScenario(
  asset: AssetConfig,
  drivers: Drivers,
  a: ScenarioAssumptions,
  H: number,
  instances: Instance[],
  probability: number,
): ScenarioOutput {
  const stakedRatio = need(a, 'staked_ratio_horizon');
  if (!(stakedRatio > 0)) throw new EngineError('staked_ratio_horizon must be positive');
  const avgEmission = emissionsBetween(drivers.emissionSchedule, drivers.asOf, 0, H) / H;

  let target = drivers.price.value;
  let supply = 0;
  let stakingYield = 0;
  let modules: Record<string, ModuleResult> = {};
  let iterations = 0;
  let converged = false;

  while (iterations < MAX_ITERATIONS && !converged) {
    iterations++;
    supply = forecastSupply({ asset, drivers, assumptions: a, horizonYears: H, targetPrice: target });
    // staked_ratio_horizon is a share of EFFECTIVE supply, so the yield denominator uses the
    // effective-basis forecast. On the effective_total basis the two are the same number.
    const effectiveSupply =
      asset.supply_basis === 'circulating'
        ? forecastSupply({ asset, drivers, assumptions: a, horizonYears: H, targetPrice: target, basis: 'effective_total' })
        : supply;
    stakingYield = (avgEmission * drivers.stakerEmissionShare.value) / (stakedRatio * effectiveSupply);
    modules = {};
    let next = 0;
    for (const { def, impl } of instances) {
      const result = impl.compute({
        instanceId: def.id,
        params: def.params,
        drivers,
        assumptions: a,
        horizonYears: H,
        supplyAtHorizon: supply,
        priceAtHorizon: target,
        stakingYieldAtHorizon: stakingYield,
      });
      if (!Number.isFinite(result.valuePerToken)) throw new EngineError(`module ${def.id} returned a non-finite value`);
      modules[def.id] = result;
      next += def.kind === 'estimate' ? (def.weight ?? 0) * result.valuePerToken : result.valuePerToken;
    }
    next = Math.max(0, next);
    converged = Math.abs(next - target) / Math.max(Math.abs(target), 1e-12) < TOLERANCE;
    target = next;
  }

  const estimates = instances
    .filter((i) => i.def.kind === 'estimate')
    .map((i) => ({ weight: i.def.weight ?? 0, value: modules[i.def.id].valuePerToken }));

  return { target, probability, supplyAtHorizon: supply, stakingYield, iterations, converged, dispersion: dispersionOf(estimates), modules };
}

export function runEngine(input: EngineInput): EngineOutput {
  const { asset, drivers, assumptions } = input;
  const spot = drivers.price.value;
  if (!(spot > 0)) throw new EngineError('spot price must be positive');
  const instances: Instance[] = asset.modules.map((def) => ({ def, impl: getModule(def.type) }));
  const probs = asset.scenario_probabilities;

  const horizons = {} as Record<Horizon, HorizonOutput>;
  let allConverged = true;

  for (const h of HORIZONS) {
    const H = HORIZON_YEARS[h];
    const scenarios = {} as Record<Scenario, ScenarioOutput>;
    for (const s of SCENARIOS) {
      scenarios[s] = solveScenario(asset, drivers, assumptions[s], H, instances, probs[s]);
      if (!scenarios[s].converged) allConverged = false;
    }

    const expectedTarget = SCENARIOS.reduce((sum, s) => sum + probs[s] * scenarios[s].target, 0);
    const expectedYield = SCENARIOS.reduce((sum, s) => sum + probs[s] * scenarios[s].stakingYield, 0);

    const modules: Record<string, ModuleSummary> = {};
    for (const { def } of instances) {
      const byScenario = {} as Record<Scenario, number>;
      for (const s of SCENARIOS) byScenario[s] = scenarios[s].modules[def.id].valuePerToken;
      modules[def.id] = {
        type: def.type,
        kind: def.kind,
        weight: def.kind === 'estimate' ? (def.weight ?? 0) : null,
        value: SCENARIOS.reduce((sum, s) => sum + probs[s] * byScenario[s], 0),
        byScenario,
        breakdown: scenarios.base.modules[def.id].breakdown,
      };
    }

    const totalReturn = (multiplier: number) =>
      ((expectedTarget / spot) * Math.pow(1 + expectedYield * multiplier, H) - 1) * 100;

    const extras: Record<string, number> = {};
    for (const v of asset.total_return_variants) {
      const m = drivers.extra[v.yield_multiplier_metric];
      if (!m) throw new EngineError(`total return variant ${v.id} needs extra driver "${v.yield_multiplier_metric}"`);
      extras[v.id] = totalReturn(m.value);
    }

    horizons[h] = {
      expectedTarget,
      upsidePct: (expectedTarget / spot - 1) * 100,
      scenarios,
      modules,
      dispersion: dispersionOf(
        instances.filter((i) => i.def.kind === 'estimate').map((i) => ({ weight: i.def.weight ?? 0, value: modules[i.def.id].value })),
      ),
      stakedTotalReturnPct: totalReturn(1),
      extras,
    };
  }

  return { engineVersion: ENGINE_VERSION, asOf: drivers.asOf, spot, converged: allConverged, horizons };
}
