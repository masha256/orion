import type { SourceType } from '../report/sourceTypes.js';
import type { ObservationSource } from '../types.js';
import type { Locator, ProvenanceMethod } from './types.js';

/**
 * The observation's origin (`onchain` | `api` | `manual`), derived from its provenance: since 0006 (Task 10, gate G3) the
 * `observations.source` column is gone and this is the one function every reader uses in its place. It is what the
 * column held, row for row (rulings R10.2 / R10.2a, proved on the prod copy before the drop):
 *
 * - disclosed: a constant is `api` (the constant source stamped it so); anything else (a disclosure: `data set`, an
 *   approved observation proposal, the analyst's ledger, a confirmed provisional row, a pre-v2 seed) is `manual`.
 * - derived: a formula named `manual_*` (R17's correction of a DefiLlama day to the mean of its neighbours) is `manual`;
 *   a derivation over a third-party rung (DefiLlama) is `api`; any other derivation (over transfer scans) is `onchain`.
 * - measured: a log or pool scan is `onchain`; a contract read is `onchain` unless its adapter declares otherwise
 *   (ADAPTER_ORIGINS: Solana's supply drop is an `api` series); an API rung (first party, market data, third party) is `api`.
 *
 * Inputs are the method, the rung, the locator's `adapter` and the formula's prefix only (R10.2a).
 */

export interface OriginFields {
  method: ProvenanceMethod;
  sourceType: SourceType;
  locator: Locator | null;
  formula?: string | null;
}

/**
 * The source each code adapter's readings stamp (`level(...)`, `source: ...` in the adapter, or the series writer it
 * feeds: an adapter's daily series is written by `writeApiFlow` as `api`). Only a contract-state adapter consults it; the
 * rest are listed so a new adapter has to say. Retired names whose rows history still holds stay listed.
 */
export const ADAPTER_ORIGINS: Readonly<Record<string, 'onchain' | 'api'>> = {
  'aero.emission_rate_annual': 'onchain', // retired (main d2dad4a), rows on prod
  'aero.staker_emission_share': 'onchain', // retired (main d2dad4a), rows on prod
  'cake.emission_rate_annual': 'onchain',
  'chain.counter_rate': 'onchain',
  'chain.view_sum': 'onchain',
  'chain.v2_pool_twap_price': 'onchain',
  'chain.cl_pool_spot_price': 'onchain',
  'crv.emission_rate_annual': 'onchain',
  'hype.total_supply': 'api',
  'hype.staked_supply': 'api',
  'hype.emission_rate_annual': 'api',
  'hype.fund_buys_daily': 'api',
  'hype.reserve_yield_payments': 'api',
  'lit.treasury_buys_daily': 'api',
  'lit.exchange_fees_daily': 'api',
  'lit.app_fee_share': 'api',
  'lit.staking_pool': 'api',
  'lit.unlocks_next_year': 'api',
  'solana.token_supply': 'onchain',
  'solana.owner_balance': 'onchain',
  'solana.supply_burn_daily': 'api',
  'vvv.staker_emission_share': 'onchain',
  'vvv.diem_target_supply': 'onchain',
  'vvv.staker_share_from_api': 'api',
  'vvv.burn_history_tokens': 'api',
};

const MANUAL_FORMULA = 'manual_';

export function originOf(p: OriginFields): ObservationSource {
  switch (p.method) {
    case 'disclosed':
      return p.sourceType === 'constant' ? 'api' : 'manual';
    case 'derived':
      if ((p.formula ?? '').startsWith(MANUAL_FORMULA)) return 'manual';
      return p.sourceType === 'third_party' ? 'api' : 'onchain';
    case 'measured':
      switch (p.sourceType) {
        case 'log_scan':
        case 'pool_scan':
          return 'onchain';
        case 'contract_state': {
          const name = p.locator?.adapter;
          return (typeof name === 'string' ? ADAPTER_ORIGINS[name] : undefined) ?? 'onchain';
        }
        default:
          return 'api';
      }
  }
}

/** The provenance columns `originOf` reads, as a SELECT returns them (`method, source_type, locator, formula`). */
export interface OriginRow {
  method: ProvenanceMethod;
  source_type: SourceType;
  locator: Locator | null;
  formula: string | null;
}

export const originOfRow = (r: OriginRow): ObservationSource => originOf({ method: r.method, sourceType: r.source_type, locator: r.locator, formula: r.formula });
