import type { AssetConfig } from '../config/schema.js';
import { OrionError, SCENARIOS, type AssumptionValues } from '../types.js';
import { captureKeys, discountRateFor, REVENUE_KEYS } from './modules/keys.js';
import { getModule } from './modules/registry.js';
import type { FlowRef, ValuationModule } from './modules/types.js';

export function flowRefs(asset: AssetConfig): FlowRef[] {
  return asset.holder_flows.map((f) => ({ id: f.id, captureRule: f.capture_rule }));
}

function tryModule(type: string): ValuationModule | null {
  try {
    return getModule(type);
  } catch (err) {
    if (err instanceof OrionError) return null;
    throw err;
  }
}

export function requiredAssumptionKeys(asset: AssetConfig): string[] {
  const flows = flowRefs(asset);
  const keys = new Set<string>([...REVENUE_KEYS, ...captureKeys(flows), 'staked_ratio_horizon']);
  for (const m of asset.modules) {
    const impl = tryModule(m.type);
    if (impl) for (const k of impl.assumptionKeys(m.id, m.params, flows)) keys.add(k);
  }
  return [...keys].sort();
}

export function requiredExtraMetrics(asset: AssetConfig): string[] {
  const keys = new Set<string>(asset.total_return_variants.map((v) => v.yield_multiplier_metric));
  for (const m of asset.modules) {
    const impl = tryModule(m.type);
    if (impl) for (const k of impl.requiredExtra(m.params)) keys.add(k);
  }
  return [...keys].sort();
}

export function validateAssetModules(asset: AssetConfig): string[] {
  const errors: string[] = [];
  for (const m of asset.modules) {
    const impl = tryModule(m.type);
    if (!impl) {
      errors.push(`modules.${m.id}: unknown module type "${m.type}"`);
      continue;
    }
    if (!impl.allowedKinds.includes(m.kind)) errors.push(`modules.${m.id}: type ${m.type} cannot be a ${m.kind}`);
    for (const e of impl.validateParams(m.params)) errors.push(`modules.${m.id}.params: ${e}`);
  }
  for (const key of requiredAssumptionKeys(asset)) {
    if (!asset.assumptions[key]) errors.push(`assumptions: required key "${key}" has no bounds`);
  }
  for (const key of requiredExtraMetrics(asset)) {
    if (asset.metrics[key]?.type !== 'level') errors.push(`metrics: required extra metric "${key}" must be defined with type level`);
  }
  return errors;
}

export function validateAssumptions(
  asset: AssetConfig,
  values: AssumptionValues,
  opts: { checkBounds?: boolean } = {},
): string[] {
  const checkBounds = opts.checkBounds ?? true;
  const required = requiredAssumptionKeys(asset);
  const errors: string[] = [];
  const usesCashflow = asset.modules.some((m) => m.type === 'holder_cashflow');

  for (const s of SCENARIOS) {
    const a = values[s] ?? {};
    for (const key of required) {
      if (a[key] === undefined || !Number.isFinite(a[key])) errors.push(`${s}: missing ${key}`);
    }
    for (const key of Object.keys(a)) {
      if (!required.includes(key)) errors.push(`${s}: unknown key ${key}`);
    }
    if (checkBounds) {
      for (const key of required) {
        const b = asset.assumptions[key];
        const v = a[key];
        if (b && v !== undefined && (v < b.min || v > b.max)) {
          errors.push(`${s}: ${key} = ${v} is outside [${b.min}, ${b.max}]`);
        }
      }
    }
    if (a.rev_growth_y1 !== undefined && a.rev_growth_y1 <= -1) errors.push(`${s}: rev_growth_y1 must be greater than -1`);
    if (usesCashflow && a.discount_rate_base !== undefined && a.terminal_growth !== undefined) {
      for (const f of flowRefs(asset)) {
        let r: number;
        try {
          r = discountRateFor(f.captureRule, a);
        } catch {
          continue; // the missing premium key is already reported above
        }
        if (r <= a.terminal_growth) {
          errors.push(`${s}: discount rate ${r} for flow ${f.id} must exceed terminal growth ${a.terminal_growth}`);
        }
      }
    }
  }
  return errors;
}
