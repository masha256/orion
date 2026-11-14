import type { PriceEntry } from '../../prices/config.js';
import { OrionError } from '../../types.js';
import type { SourceContext, SourceValue } from '../types.js';
import { cakeAdapters } from './cake.js';
import { crvAdapters } from './crv.js';
import { evmAdapters } from './evm.js';
import { hypeAdapters } from './hype.js';
import { litAdapters } from './lit.js';
import { priceAdapters } from './price.js';
import { scheduleAdapters } from './schedule.js';
import { solanaAdapters } from './solana.js';
import { vvvAdapters } from './vvv.js';

/** A named code adapter: the escape hatch for metrics the declarative source types cannot express. */
export interface AdapterDef {
  name: string;
  /**
   * True when the adapter reads the chain, so the run must open an RPC connection. A function when that depends on the
   * source (`price.token`: only a ref priced on an EVM chain); read it through adapterNeedsRpc.
   */
  needsRpc: boolean | ((source: AdapterSource) => boolean);
  /** What the adapter's params mean, for the analyst writing a config proposal (a disclosure run's pack shows it). */
  paramsDoc?: string;
  /** Problems with `params`, one message each (empty when valid). The asset loader runs it, so a config proposal and its approve refuse bad params. */
  validateParams?(params: Record<string, unknown>, ctx?: AdapterValidateContext): string[];
  run(ctx: SourceContext, params: Record<string, unknown>): Promise<SourceValue>;
  /**
   * The adapters whose readings this one's series is computed from (PUMP's `solana.supply_burn_daily` IS the fall in
   * `solana.token_supply`'s readings). A reconciliation check refuses two sides joined by it (spec §5, circular checks).
   */
  computedFrom?: string[];
  /**
   * True when, with these params, the adapter's series is dollars a first-party API reports (token 'usd', spec §4): the
   * run returns `token: USD_TOKEN` exactly then. The token backfill reads it to fill rows written before 0005 with
   * amount = value and no request (ruling R18).
   */
  usdNative?(params: Record<string, unknown>): boolean;
}

/** An `adapter` source as the config holds it. */
export interface AdapterSource {
  type: 'adapter';
  name: string;
  params: Record<string, unknown>;
}

/** What the asset loader knows besides the params: the prices.yaml it loads with (absent or empty: none). */
export interface AdapterValidateContext {
  prices?: ReadonlyMap<string, PriceEntry>;
}

/** Whether the source's adapter reads the chain (its needsRpc, evaluated on the source when it is a function). */
export function adapterNeedsRpc(source: AdapterSource): boolean {
  const n = getAdapter(source.name).needsRpc;
  return typeof n === 'function' ? n(source) : n;
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

/** The adapter of that name, or undefined: for callers that leave unknown names to someone else. */
export function findAdapter(name: string): AdapterDef | undefined {
  return ADAPTERS.get(name);
}

export function adapterNames(): string[] {
  return [...ADAPTERS.keys()].sort();
}

// Asset-specific adapters register here.
for (const adapter of [...vvvAdapters, ...hypeAdapters, ...crvAdapters, ...cakeAdapters, ...litAdapters, ...solanaAdapters, ...evmAdapters, ...scheduleAdapters, ...priceAdapters]) registerAdapter(adapter);
