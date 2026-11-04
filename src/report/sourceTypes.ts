import type { MetricDef } from '../config/schema.js';
import type { SourceConfig } from '../config/sources.js';

/**
 * The source ladder (spec 2026-10-28 §2): the rung every metric's primary source sits on. `third_party` is the label for
 * what Phase 3 removes (DefiLlama, community APIs such as Llama Airforce's llama.box), so the report can flag every
 * figure that still depends on one.
 */
export type SourceType =
  | 'contract_state'
  | 'log_scan'
  | 'first_party_api'
  | 'pool_scan'
  | 'disclosure'
  | 'derived'
  | 'constant'
  | 'market_data'
  | 'third_party';

/** The rungs a listed protocol's revenue, holder and supply lines may sit on (spec §2 deferral, D6). */
export const LISTING_RUNGS: ReadonlySet<SourceType> = new Set(['contract_state', 'log_scan', 'first_party_api', 'pool_scan', 'disclosure', 'derived', 'constant', 'market_data']);

/**
 * Each code adapter's rung, by name, read from what the adapter calls: chain reads are contract state, a protocol's own
 * API is first party. `lit.unlocks_next_year` reads DefiLlama's emissions dataset (its default url), so it is third party
 * although the other `lit.*` adapters read Lighter. An adapter missing here has no rung (null) until it is added.
 */
export const ADAPTER_SOURCE_TYPES: Readonly<Record<string, SourceType>> = {
  'aero.emission_rate_annual': 'contract_state',
  'aero.staker_emission_share': 'contract_state',
  'cake.emission_rate_annual': 'contract_state',
  'crv.emission_rate_annual': 'contract_state',
  'hype.total_supply': 'first_party_api',
  'hype.staked_supply': 'first_party_api',
  'hype.emission_rate_annual': 'first_party_api',
  'hype.fund_buys_daily': 'first_party_api',
  'hype.reserve_yield_payments': 'first_party_api',
  'lit.treasury_buys_daily': 'first_party_api',
  'lit.exchange_fees_daily': 'first_party_api',
  'lit.app_fee_share': 'first_party_api',
  'lit.staking_pool': 'first_party_api',
  'lit.unlocks_next_year': 'third_party',
  'solana.token_supply': 'contract_state',
  'solana.owner_balance': 'contract_state',
  'solana.supply_burn_daily': 'contract_state',
  'vvv.staker_emission_share': 'contract_state',
  'vvv.diem_target_supply': 'contract_state',
  'vvv.staker_share_from_api': 'first_party_api',
  'vvv.burn_history_tokens': 'first_party_api',
};

/** Hosts of third-party aggregators reached through `http_json` (DefiLlama's coins/api hosts, Llama Airforce). */
const THIRD_PARTY_HOST = /(^|\.)llama\.(fi|box)$/;

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
};

function typeOfSource(s: SourceConfig): SourceType | null {
  switch (s.type) {
    case 'coingecko':
      return 'market_data';
    case 'transfer_flow':
      return 'log_scan';
    case 'contract_read':
    case 'erc20_supply':
      return 'contract_state';
    case 'adapter':
      return ADAPTER_SOURCE_TYPES[s.name] ?? null;
    case 'defillama':
    case 'defillama_share':
      return 'third_party';
    case 'http_json':
      return THIRD_PARTY_HOST.test(hostOf(s.url)) ? 'third_party' : 'first_party_api';
    case 'constant':
      return 'constant';
    case 'derived':
      return 'derived';
  }
}

/** A metric's rung, from its primary source; a metric with no source is entered by hand with a citation (disclosure). */
export function sourceTypeOf(def: MetricDef): SourceType | null {
  if (def.source === undefined) return def.fetcher === 'manual' ? 'disclosure' : null;
  return typeOfSource(def.source);
}

/** `<rung>:<what>` for the provenance list: the adapter name, the API host, or the source type. Never a full URL (keys). */
export function sourceLabelOf(def: MetricDef): string | null {
  const t = sourceTypeOf(def);
  if (t === null) return null;
  const s = def.source;
  if (s === undefined) return `${t}:manual`;
  if (s.type === 'adapter') return `${t}:${s.name}`;
  if (s.type === 'http_json') return `${t}:${hostOf(s.url)}`;
  return `${t}:${s.type}`;
}
