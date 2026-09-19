import { OrionError } from '../../types.js';
import { forwardMultiple } from './forwardMultiple.js';
import { holderCashflow } from './holderCashflow.js';
import type { ValuationModule } from './types.js';
import { utilityClaim } from './utilityClaim.js';

const MODULES = new Map<string, ValuationModule>();

export function registerModule(m: ValuationModule): void {
  MODULES.set(m.type, m);
}

registerModule(holderCashflow);
registerModule(forwardMultiple);
registerModule(utilityClaim);

export function getModule(type: string): ValuationModule {
  const m = MODULES.get(type);
  if (!m) throw new OrionError('unknown_module', `unknown module type: ${type}`);
  return m;
}

export function moduleTypes(): string[] {
  return [...MODULES.keys()].sort();
}
