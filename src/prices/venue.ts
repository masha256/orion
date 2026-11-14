import type { PriceEntry, PriceMethod } from './config.js';

/**
 * Where a `price.token` / `price.token_check` source reads (Phase 3 R2 Task 6b): the rung, CAIP-2 chain and RPC need of
 * the ref's primary (price.token) or check (price.token_check), from its prices.yaml method. An EVM method is on-chain
 * contract state read at the run block; a Solana method is contract state read through our Solana RPC; a venue's candle
 * (Hyperliquid, Lighter) is its first-party API. Kept free of imports beyond types: src/report/sourceTypes.ts and
 * src/provenance/locator.ts read it, below the adapters in the import graph.
 *
 * The rung is a property of the ref's method, which only prices.yaml knows; the asset loader (parseAssetObject, given
 * the prices map) notes each price source's venue on the parsed source object (notePriceVenues). A source parsed
 * without prices.yaml falls back to the ref's namespace (hyperliquid: first party; solana and eip155: contract state),
 * which is right for every ref but one whose eip155 address is priced off chain (LIT on Lighter).
 */

export const PRICE_ADAPTERS = ['price.token', 'price.token_check'] as const;
export type PriceAdapterName = (typeof PRICE_ADAPTERS)[number];
export const isPriceAdapter = (name: string): name is PriceAdapterName => (PRICE_ADAPTERS as readonly string[]).includes(name);

export interface PriceVenue {
  rung: 'contract_state' | 'first_party_api';
  /** CAIP-2 chain of the read (`eip155:<id>`, `solana:mainnet`, `hyperliquid:core`), null off chain (Lighter). */
  chain: string | null;
  /** True when the method reads an EVM chain (a run opens the asset's RPC for it). */
  rpc: boolean;
}

const EVM_REF = /^eip155:(\d+)\//;

/** The venue of one method of `entry` (its primary, or its check). */
export function venueOfMethod(entry: Pick<PriceEntry, 'ref'>, m: Pick<PriceMethod, 'kind'>): PriceVenue {
  const evm = EVM_REF.exec(entry.ref);
  switch (m.kind) {
    case 'hyperliquid_candle':
      return { rung: 'first_party_api', chain: 'hyperliquid:core', rpc: false };
    case 'lighter_candle':
      return { rung: 'first_party_api', chain: null, rpc: false };
    case 'solana_vaults':
    case 'meteora_dlmm':
      return { rung: 'contract_state', chain: 'solana:mainnet', rpc: false };
    default:
      return { rung: 'contract_state', chain: evm ? `eip155:${evm[1]}` : null, rpc: true };
  }
}

/** The venue a price adapter reads for `entry`: price.token its primary, price.token_check its check. */
export function priceVenue(name: PriceAdapterName, entry: PriceEntry): PriceVenue {
  return venueOfMethod(entry, name === 'price.token' ? entry.primary : entry.check);
}

/** The venue from the ref's namespace alone, for a source parsed without prices.yaml. */
export function venueOfRef(ref: unknown): PriceVenue {
  const r = typeof ref === 'string' ? ref : '';
  if (r.startsWith('hyperliquid:')) return { rung: 'first_party_api', chain: 'hyperliquid:core', rpc: false };
  if (r.startsWith('solana:')) return { rung: 'contract_state', chain: 'solana:mainnet', rpc: false };
  const evm = EVM_REF.exec(r);
  return { rung: 'contract_state', chain: evm ? `eip155:${evm[1]}` : null, rpc: evm !== null };
}

const NOTED = new WeakMap<object, PriceVenue>();

interface AdapterSourceLike {
  type: string;
  name?: string;
  params?: Record<string, unknown>;
}

/**
 * Notes the venue of every price.token / price.token_check source of the parsed metrics (primaries and cross-checks)
 * whose ref is in `prices`, on the source object itself (never in the config, so the hash and the YAML do not change).
 */
export function notePriceVenues(
  metrics: Readonly<Record<string, { source?: AdapterSourceLike; cross_checks?: { source: AdapterSourceLike }[] }>>,
  prices: ReadonlyMap<string, PriceEntry>,
): void {
  for (const def of Object.values(metrics)) {
    for (const s of [def.source, ...(def.cross_checks ?? []).map((c) => c.source)]) {
      if (s?.type !== 'adapter' || s.name === undefined || !isPriceAdapter(s.name)) continue;
      const entry = prices.get(String(s.params?.ref));
      if (entry) NOTED.set(s, priceVenue(s.name, entry));
    }
  }
}

/** The venue of a price adapter source: as noted at load, else from its ref's namespace. */
export function priceSourceVenue(s: AdapterSourceLike): PriceVenue {
  return NOTED.get(s) ?? venueOfRef(s.params?.ref);
}
