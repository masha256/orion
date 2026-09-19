import type { CaptureRule } from '../../config/schema.js';
import type { ScenarioAssumptions } from '../../types.js';
import { need } from '../paths.js';
import type { FlowRef } from './types.js';

export const REVENUE_KEYS = ['rev_growth_y1', 'growth_fade_years', 'terminal_growth'] as const;

export function captureKeys(flows: FlowRef[]): string[] {
  return flows.flatMap((f) => [`capture_rate_terminal.${f.id}`, `capture_ramp_years.${f.id}`]);
}

export function discountKeys(flows: FlowRef[]): string[] {
  const keys = ['discount_rate_base'];
  if (flows.some((f) => f.captureRule === 'programmatic')) keys.push('discount_premium_programmatic');
  if (flows.some((f) => f.captureRule === 'discretionary')) keys.push('discount_premium_discretionary');
  return keys;
}

export function discountRateFor(rule: CaptureRule, a: ScenarioAssumptions): number {
  const base = need(a, 'discount_rate_base');
  if (rule === 'programmatic') return base + need(a, 'discount_premium_programmatic');
  if (rule === 'discretionary') return base + need(a, 'discount_premium_discretionary');
  return base;
}
