import { OrionError } from '../../types.js';
import type { SourceContext, SourceValue } from '../types.js';
import { vvvAdapters } from './vvv.js';

/** A named code adapter: the escape hatch for metrics the declarative source types cannot express. */
export interface AdapterDef {
  name: string;
  /** True when the adapter reads the chain, so the run must open an RPC connection. */
  needsRpc: boolean;
  run(ctx: SourceContext, params: Record<string, unknown>): Promise<SourceValue>;
}

const ADAPTERS = new Map<string, AdapterDef>();

export function registerAdapter(def: AdapterDef): void {
  ADAPTERS.set(def.name, def);
}

export function getAdapter(name: string): AdapterDef {
  const def = ADAPTERS.get(name);
  if (!def) throw new OrionError('unknown_adapter', `unknown adapter: ${name}`);
  return def;
}

export function adapterNames(): string[] {
  return [...ADAPTERS.keys()].sort();
}

// Asset-specific adapters register here, exactly as custom valuation modules do in the engine registry.
for (const adapter of vvvAdapters) registerAdapter(adapter);
