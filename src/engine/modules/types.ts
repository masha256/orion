import type { CaptureRule, ModuleKind } from '../../config/schema.js';
import type { Drivers } from '../../drivers/compute.js';
import type { ScenarioAssumptions } from '../../types.js';

export interface FlowRef {
  id: string;
  captureRule: CaptureRule;
}

export interface ModuleContext {
  instanceId: string;
  params: Record<string, unknown>;
  drivers: Drivers;
  assumptions: ScenarioAssumptions;
  horizonYears: number;
  supplyAtHorizon: number;
  priceAtHorizon: number;
  stakingYieldAtHorizon: number;
}

export interface ModuleResult {
  valuePerToken: number;
  breakdown: Record<string, unknown>;
}

export interface ValuationModule {
  type: string;
  allowedKinds: readonly ModuleKind[];
  validateParams(params: Record<string, unknown>): string[];
  assumptionKeys(instanceId: string, params: Record<string, unknown>, flows: FlowRef[]): string[];
  requiredExtra(params: Record<string, unknown>): string[];
  compute(ctx: ModuleContext): ModuleResult;
}
