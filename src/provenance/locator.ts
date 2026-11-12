import type { AssetConfig, MetricDef } from '../config/schema.js';
import { isChainSource, type SourceConfig } from '../config/sources.js';
import { DEFILLAMA_API } from '../ingest/sources/defillama.js';
import { ADAPTER_SOURCE_TYPES, derivedInputs, sourceTypeOf, type SourceType } from '../report/sourceTypes.js';
import { OrionError } from '../types.js';
import { scrubLocator } from './scrub.js';
import { codeVersion, type Json, type Locator, type Provenance, type ProvenanceMethod } from './types.js';

export { isSecretName, scrubLocator, scrubText, scrubUrl } from './scrub.js';
export { disclosedProvenance } from './types.js';

/**
 * Locators (spec §3): built from the asset config, one shape per source type, and scrubbed of anything that could carry a
 * key (`./scrub.ts`, re-exported here). Every writer passes its locator through `scrubLocator` (insertObservation does it
 * again), so a keyed RPC or API URL never reaches a row (Review Focus 4).
 */

const toJson = (v: unknown): Json => JSON.parse(JSON.stringify(v ?? null)) as Json;

/** Contract names to addresses, in the asset's own spelling. */
function addresses(asset: AssetConfig, names: readonly string[]): Record<string, string> {
  return Object.fromEntries(names.map((n) => [n, asset.contracts[n] ?? n]));
}

/** The locator of a configured source (spec §3 shapes), before scrubbing. */
export function locatorOfSource(asset: AssetConfig, metricKey: string, s: SourceConfig): Locator {
  const addr = (n: string): string => asset.contracts[n] ?? n;
  switch (s.type) {
    case 'coingecko':
      return { provider: 'coingecko', endpoint: '/coins/markets', id: s.id, field: s.field };
    case 'http_json':
      return { endpoint: s.url, path: s.path };
    case 'defillama':
      return { endpoint: `${DEFILLAMA_API}/summary/fees/${encodeURIComponent(s.slug)}`, request: { dataType: s.data_type } };
    case 'defillama_share':
      return {
        endpoint: `${DEFILLAMA_API}/overview/${s.overview}${s.chain ? `/${encodeURIComponent(s.chain)}` : ''}`,
        request: { parent: s.parent, category: s.category, window: s.window },
      };
    case 'erc20_supply':
      return { contracts: [addr(s.token)], call: 'totalSupply()', args: [], subtract_balances: addresses(asset, s.subtract_balances) };
    case 'contract_read': {
      const args = s.args ?? [];
      return {
        contracts: [addr(s.contract)], call: `${s.function}(${args.map(() => 'address').join(',')})`, args: args.map(addr),
        ...(s.pick !== undefined ? { pick: s.pick } : {}),
      };
    }
    case 'transfer_flow': {
      const counted = s.count_from ?? s.from_allowlist ?? [];
      return {
        contracts: [addr(s.token)], event: 'Transfer(address,address,uint256)', topics: { to: addr(s.to) },
        senders: s.from_any ? 'any' : addresses(asset, counted),
        ...(s.from_ignore ? { ignore: addresses(asset, s.from_ignore) } : {}),
      };
    }
    case 'adapter':
      return { adapter: s.name, params: toJson(s.params) };
    case 'constant':
      return { config_path: `metrics.${metricKey}.source`, note: s.note };
    case 'derived':
      return { metrics: derivedInputs(s), params: toJson(s.params) };
  }
}

/**
 * CAIP-2 chain of a source: the asset's EVM chain for chain reads and contract-state adapters, Solana / HyperCore for
 * those adapters; null off chain. Read from the adapter's rung, not the registry: the observation writers sit below the
 * adapters in the import graph (solana.ts imports flow.ts).
 */
export function chainOfSource(asset: AssetConfig, s: SourceConfig): string | null {
  const evm = asset.ingest ? `eip155:${asset.ingest.chain_id}` : null;
  if (isChainSource(s)) return evm;
  if (s.type !== 'adapter') return null;
  if (s.name.startsWith('solana.')) return 'solana:mainnet';
  if (s.name.startsWith('hype.')) return 'hyperliquid:core';
  return ADAPTER_SOURCE_TYPES[s.name] === 'contract_state' ? evm : null;
}

/** DefiLlama's API hosts: a row read from one is third party (the token backfill skips it). */
const DEFILLAMA_HOSTS: ReadonlySet<string> = new Set(['api.llama.fi', 'coins.llama.fi', 'pro-api.llama.fi', 'yields.llama.fi']);

/** The first URL in a source detail on a DefiLlama host, or null. */
export function defillamaUrlOf(detail: string | null): string | null {
  for (const [u] of (detail ?? '').matchAll(/\bhttps?:\/\/[^\s"'<>]+/g)) {
    try {
      if (DEFILLAMA_HOSTS.has(new URL(u).hostname)) return u;
    } catch {
      // not a URL
    }
  }
  return null;
}

/**
 * The method a source's rows carry (spec §2): a formula is derived, a constant is disclosed, and so is an adapter on the
 * disclosure rung (a cited schedule it computes: `schedule.unlocks_next_year`); everything read is measured.
 */
export function methodOfSource(s: SourceConfig | undefined): ProvenanceMethod {
  if (s === undefined || s.type === 'constant') return 'disclosed';
  if (s.type === 'adapter' && ADAPTER_SOURCE_TYPES[s.name] === 'disclosure') return 'disclosed';
  return s.type === 'derived' ? 'derived' : 'measured';
}

/** The asset an observation belongs to, as loaded: its config and its config hash. */
export interface ProvenanceAsset {
  config: AssetConfig;
  hash: string;
}

/**
 * The provenance of a fetched row of `metricKey`, from the asset config (rung, method, chain, locator) plus what the
 * writer measured (`extra`: blocks, tx refs, a response digest, a formula). Refuses a metric with no source or a source
 * with no rung (an adapter missing from ADAPTER_SOURCE_TYPES): every row must say where it came from.
 */
export function fetchedProvenance(asset: ProvenanceAsset, metricKey: string, extra: Partial<Provenance> = {}): Provenance {
  const def: MetricDef | undefined = asset.config.metrics[metricKey];
  if (def?.source === undefined) throw new OrionError('no_provenance', `metrics.${metricKey}: a fetched row needs a configured source`);
  const sourceType: SourceType | null = sourceTypeOf(def, asset.config.metrics);
  if (sourceType === null) throw new OrionError('no_provenance', `metrics.${metricKey}: source ${def.source.type} has no source type (add the adapter to ADAPTER_SOURCE_TYPES)`);
  return {
    method: methodOfSource(def.source), sourceType, chain: chainOfSource(asset.config, def.source),
    locator: scrubLocator(locatorOfSource(asset.config, metricKey, def.source)),
    codeVersion: codeVersion(), configHash: asset.hash,
    ...extra,
  };
}

/**
 * `<rung>:<what>` for a report's provenance sources, from a row: the adapter, the API host, the market data provider, the
 * chain, else the rung alone. Never a full URL.
 */
export function provenanceLabel(sourceType: string, chain: string | null, locator: Locator | null): string {
  const l = locator ?? {};
  if (typeof l.adapter === 'string') return `${sourceType}:${l.adapter}`;
  if (typeof l.provider === 'string') return `${sourceType}:${l.provider}`;
  if (typeof l.endpoint === 'string') {
    try {
      return `${sourceType}:${new URL(l.endpoint).hostname}`;
    } catch {
      // not a URL: fall through
    }
  }
  if (chain !== null) return `${sourceType}:${chain}`;
  return sourceType;
}
