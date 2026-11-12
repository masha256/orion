import type { SourceType } from '../report/sourceTypes.js';
import type { ObservationSource } from '../types.js';
import type { Locator, ProvenanceMethod } from './types.js';

/**
 * The observation's origin (`onchain` | `api` | `manual`), derived from its provenance: since 0006 (Task 10, gate G3) the
 * `observations.source` column is gone and this is the one function every reader uses in its place. It is what the
 * column held, row for row (rulings R10.2 / R10.2a, proved on the prod copy before the drop):
 *
 * - disclosed: a constant is `api` (the constant source stamped it so), and so is a cited schedule an adapter computes
 *   (rung `disclosure` with `locator.adapter`: `schedule.unlocks_next_year` stamps `api`); anything else (a disclosure:
 *   `data set`, an approved observation proposal, the analyst's ledger, a confirmed provisional row, a pre-v2 seed, none
 *   of which has an adapter in its locator) is `manual`.
 * - derived: a formula named `manual_*` (R17's correction of a DefiLlama day to the mean of its neighbours) is `manual`;
 *   a derivation whose inputs are sourced from DefiLlama or an adapter (run.ts writes `input_origin: 'api'` into its
 *   locator then, ruling R10.7) or that sits on a third-party rung (DefiLlama, rows written before R10.7) is `api`; any
 *   other derivation (over transfer scans) is `onchain`.
 * - measured: a log or pool scan is `onchain`; a contract read is `onchain` unless its adapter declares otherwise
 *   (ADAPTER_ORIGINS: Solana's supply drop is an `api` series); an API rung (first party, market data, third party) is `api`.
 *
 * Inputs are the method, the rung, the locator's `adapter` and `input_origin`, and the formula's prefix only (R10.2a, R10.7).
 */

export interface OriginFields {
  method: ProvenanceMethod;
  sourceType: SourceType;
  locator: Locator | null;
  formula?: string | null;
}

/**
 * The origin a contract-state adapter's rows carry, by adapter name: the only rung where `originOf` needs the adapter
 * (every other measured rung is `api` or `onchain` by the rung alone, so first-party and third-party adapters are not
 * listed). A level or schedule stamps its reading's `source`; a daily series or periodic payments are stamped
 * SERIES_ORIGIN by their writer (Solana's supply drop). tests/provenance/adapterOrigins.test.ts runs every registered
 * adapter and fails when an entry here, or a missing one, disagrees with what its writer stamps. Retired names whose
 * rows history still holds stay listed.
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
  'solana.token_supply': 'onchain',
  'solana.owner_balance': 'onchain',
  'solana.supply_burn_daily': 'api',
  'vvv.staker_emission_share': 'onchain',
  'vvv.diem_target_supply': 'onchain',
};

/** The origin the series writers (`writeApiFlow`, `writePeriodicPayments`) stamp on every row they write. */
export const SERIES_ORIGIN = 'api' as const;

/** The locator key a derivation over DefiLlama or adapter inputs carries (R10.7); written only with the value 'api'. */
export const INPUT_ORIGIN_KEY = 'input_origin';

const MANUAL_FORMULA = 'manual_';

export function originOf(p: OriginFields): ObservationSource {
  switch (p.method) {
    case 'disclosed':
      return p.sourceType === 'constant' || typeof p.locator?.adapter === 'string' ? 'api' : 'manual';
    case 'derived':
      if ((p.formula ?? '').startsWith(MANUAL_FORMULA)) return 'manual';
      if (p.locator?.[INPUT_ORIGIN_KEY] === 'api') return 'api';
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
