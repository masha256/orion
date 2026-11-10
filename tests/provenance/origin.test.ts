import { describe, expect, it } from 'vitest';
import { adapterNames } from '../../src/ingest/adapters/registry.js';
import { ADAPTER_ORIGINS, originOf, type OriginFields } from '../../src/provenance/origin.js';
import { ADAPTER_SOURCE_TYPES } from '../../src/report/sourceTypes.js';
import type { ObservationSource } from '../../src/types.js';

/**
 * Task 10 (G3, rulings R10.2 / R10.2a): `observations.source` is gone; `originOf` derives it from the provenance columns
 * (method, source_type, the locator's adapter and the formula prefix) and must reproduce the stored column on every row
 * shape. The first table is the controller's prod measurement (2026-11-10, all 27,533 rows: every (method, source_type,
 * stored source) combination with its locator shapes); the second adds the shapes the writers in src can produce that
 * prod has none of.
 */
type Shape = [label: string, fields: OriginFields, stored: ObservationSource];

const contract = (locator: OriginFields['locator']): OriginFields => ({ method: 'measured', sourceType: 'contract_state', locator, formula: null });
const adapter = (name: string): OriginFields => contract({ adapter: name, params: {} });

const PROD: Shape[] = [
  // derived: R17's correction (stored 'manual') and every fetched derivation (flow_annualized, burn_momentum), pre-v2 and not.
  ['R17 2a correction', { method: 'derived', sourceType: 'derived', locator: { note: 'DefiLlama artifact: mean of neighbours' }, formula: 'manual_mean_of_neighbours@1' }, 'manual'],
  ['flow_annualized', { method: 'derived', sourceType: 'derived', locator: { metrics: ['flow_tokens.released_hub'], params: { metric: 'flow_tokens.released_hub', days: 91 } }, formula: 'flow_annualized@1' }, 'onchain'],
  ['burn_momentum', { method: 'derived', sourceType: 'derived', locator: { metrics: ['flow_usd.burn_programmatic'], params: {} }, formula: 'burn_momentum@1' }, 'onchain'],
  // disclosed: constants (stored 'api') and disclosures (data set, approve, ledger, confirm, R17 2b seeds).
  ['constant', { method: 'disclosed', sourceType: 'constant', locator: { config_path: 'metrics.staked_supply.source', note: 'no staking' }, formula: null }, 'api'],
  ['disclosure', { method: 'disclosed', sourceType: 'disclosure', locator: { citation_url: 'https://x.test/a', approved_by: null, approved_at: null }, formula: null }, 'manual'],
  ['R17 2b legacy seed', { method: 'disclosed', sourceType: 'disclosure', locator: { note: 'research pass', legacy_seed: true }, formula: null }, 'manual'],
  // measured contract_state: the one adapter that stamps 'api', then every 'onchain' locator shape on prod.
  ['solana.supply_burn_daily', adapter('solana.supply_burn_daily'), 'api'],
  ['contract_read', contract({ contracts: ['0xabc'], call: 'balanceOf(address)', args: ['0xdef'] }), 'onchain'],
  ['contract_read pick', contract({ contracts: ['0xabc'], call: 'locked(address)', args: ['0xdef'], pick: 0 }), 'onchain'],
  ['erc20_supply', contract({ contracts: ['0xabc'], call: 'totalSupply()', args: [], subtract_balances: { dead: '0xdead' } }), 'onchain'],
  ...[
    'aero.emission_rate_annual', 'aero.staker_emission_share', 'cake.emission_rate_annual', 'chain.counter_rate', 'chain.v2_pool_twap_price', 'chain.view_sum',
    'crv.emission_rate_annual', 'solana.owner_balance', 'solana.token_supply', 'vvv.diem_target_supply', 'vvv.staker_emission_share',
  ].map((n): Shape => [n, adapter(n), 'onchain']),
  // measured, every other rung on prod.
  ['first_party_api', { method: 'measured', sourceType: 'first_party_api', locator: { adapter: 'hype.fund_buys_daily', params: {} }, formula: null }, 'api'],
  ['first_party_api http_json', { method: 'measured', sourceType: 'first_party_api', locator: { endpoint: 'https://api.venice.ai/x', path: 'a.b' }, formula: null }, 'api'],
  ['log_scan', { method: 'measured', sourceType: 'log_scan', locator: { contracts: ['0xabc'], event: 'Transfer(address,address,uint256)', topics: { to: '0xdef' }, senders: 'any' }, formula: null }, 'onchain'],
  ['market_data', { method: 'measured', sourceType: 'market_data', locator: { provider: 'coingecko', endpoint: '/coins/markets', id: 'x', field: 'price' }, formula: null }, 'api'],
  ['third_party defillama', { method: 'measured', sourceType: 'third_party', locator: { endpoint: 'https://api.llama.fi/summary/fees/x', request: { dataType: 'dailyFees' } }, formula: null }, 'api'],
  ['third_party lit.unlocks_next_year', { method: 'measured', sourceType: 'third_party', locator: { adapter: 'lit.unlocks_next_year', params: {} }, formula: null }, 'api'],
];

/** Shapes a writer in src can produce that prod holds none of. */
const WRITERS: Shape[] = [
  // `data set` (no --source any more: provenance decides), an approved observation proposal, the ledger's staged rows.
  ['data set / approve / ledger', { method: 'disclosed', sourceType: 'disclosure', locator: { citation_url: 'https://x.test/b', approved_by: 'cli', approved_at: '2026-11-10T00:00:00.000Z' }, formula: null }, 'manual'],
  // A derivation over a DefiLlama flow (run.ts stamps a derivation over a defillama input 'api'; its rung inherits third_party).
  ['derived over defillama', { method: 'derived', sourceType: 'third_party', locator: { metrics: ['flow_usd.fees'], params: {} }, formula: 'flow_annualized@1' }, 'api'],
  // R10.7: a derivation over a first-party or contract-state adapter's series records input_origin 'api' in its locator.
  ['derived over an adapter series', { method: 'derived', sourceType: 'derived', locator: { metrics: ['flow_usd.af_buys_direct'], params: { metric: 'flow_usd.af_buys_direct', days: 91 }, input_origin: 'api' }, formula: 'flow_annualized@1' }, 'api'],
  ['derived over defillama, input_origin written', { method: 'derived', sourceType: 'third_party', locator: { metrics: ['flow_usd.fees'], params: {}, input_origin: 'api' }, formula: 'flow_annualized@1' }, 'api'],
  // R17's correction stays manual whatever its locator says.
  ['manual_* with input_origin', { method: 'derived', sourceType: 'derived', locator: { note: 'x', input_origin: 'api' }, formula: 'manual_mean_of_neighbours@1' }, 'manual'],
  // A pool scan (Phase 3) reads logs.
  ['pool_scan', { method: 'measured', sourceType: 'pool_scan', locator: { contracts: ['0xabc'] }, formula: null }, 'onchain'],
  // A defillama_share level, an http_json level on a llama host, the rule-5 backfill shapes (pre-v2).
  ['third_party llama.box', { method: 'measured', sourceType: 'third_party', locator: { endpoint: 'https://api.llama.box/x', path: 'a' }, formula: null }, 'api'],
  ['pre-v2 rule 5 api', { method: 'measured', sourceType: 'first_party_api', locator: { note: 'written by a source this release no longer reads' }, formula: null }, 'api'],
  // The other first-party adapters (levels and flows).
  ...['hype.total_supply', 'hype.staked_supply', 'hype.emission_rate_annual', 'hype.reserve_yield_payments', 'lit.treasury_buys_daily', 'lit.exchange_fees_daily', 'lit.app_fee_share', 'lit.staking_pool', 'vvv.staker_share_from_api'].map(
    (n): Shape => [n, { method: 'measured', sourceType: 'first_party_api', locator: { adapter: n, params: {} }, formula: null }, 'api'],
  ),
  ['chain.cl_pool_spot_price', adapter('chain.cl_pool_spot_price'), 'onchain'],
];

describe('originOf', () => {
  it.each(PROD)('prod shape %s maps back to the stored source', (_label, fields, stored) => {
    expect(originOf(fields)).toBe(stored);
  });

  it.each(WRITERS)('writer shape %s maps to the source its writer stamped', (_label, fields, stored) => {
    expect(originOf(fields)).toBe(stored);
  });

  it('ADAPTER_ORIGINS declares exactly the contract-state adapters (the only rung originOf reads it for), plus retired ones', () => {
    // Retired adapters whose rows prod still holds (aero.* before the generic chain.* adapters) stay declared. Whether each
    // declared value is the one its writer stamps: tests/provenance/adapterOrigins.test.ts.
    const RETIRED = ['aero.emission_rate_annual', 'aero.staker_emission_share'];
    const contractState = adapterNames().filter((n) => ADAPTER_SOURCE_TYPES[n] === 'contract_state');
    expect(Object.keys(ADAPTER_ORIGINS).sort()).toEqual([...contractState, ...RETIRED].sort());
  });

  it('is total: every (method, source_type) pair gives a source, and an unknown adapter name on a contract read is on chain', () => {
    const methods = ['measured', 'derived', 'disclosed'] as const;
    const types = ['contract_state', 'log_scan', 'first_party_api', 'pool_scan', 'disclosure', 'derived', 'constant', 'market_data', 'third_party'] as const;
    for (const method of methods) {
      for (const sourceType of types) {
        for (const locator of [null, {}, { adapter: 'nope.never' }] as OriginFields['locator'][]) {
          expect(['onchain', 'api', 'manual']).toContain(originOf({ method, sourceType, locator, formula: null }));
        }
      }
    }
    expect(originOf(adapter('nope.never'))).toBe('onchain');
  });
});
