# T8 fee conversion reserve

**Examples:** LINK. **Category:** `oracle`. **Example values:** LINK (`assets/link.yaml`).

Users pay for a service in many tokens; a converter swaps the fees into the protocol's token and sends them to a
reserve that holds them (buy-and-hold). Fees paid off chain are revenue only by disclosure.

## Lines

| Section | Line | Rung / source | Notes |
|---|---|---|---|
| revenue | `onchain_fees` | `log_scan`: the converter's transfers into the reserve | scope `protocol_share_only`: only fees routed through the converter |
| cost_of_revenue | `node_operators` | fee-token balances of the service contracts (`contract_state`) | `not_measured` until read; off-chain fees by disclosure |
| holders | `reserve` | `of: onchain_fees`; bucket `hold`, haircut for the overhang | |

## Addresses and endpoints to find

- The token, the reserve, the converter (the reserve's only paying sender), and the dust floor for address-poisoning
  sends (`ignore_below_tokens`).
- The service contracts that collect fees before conversion (for the Phase 3 cost lines).
- Wallets that release non-circulating supply (for `dilution`).
- The token's `prices.yaml` entry (Phase 3 R2; the file's header documents the methods): a primary (a Chainlink feed, else the deepest pool's TWAP) and a check on another venue (LINK: the LINK/USD feed, checked against the Uniswap v3 LINK/WETH TWAP). CoinGecko id
  (an identifier only: no CoinGecko field loads since Phase 3 R3).

## Checks

- `balance`: the reserve's day change in tokens vs the scanned inflows (no outflow is expected; a fall is a
  withdrawal); `tolerance_abs` covers dust under the scan's floor.
- `price`: the price level (`price.token`, the prices.yaml primary) vs its check (`price.token_check`).

## Traps

- Off-chain revenue (enterprise contracts, fees paid in fiat) is never inferred: disclosure only (T9 rules).
- The reserve can be spent: `hold` carries a haircut, and a withdrawal must show (the `balance` check).
- Releases from non-circulating wallets are dilution of tokens already in total supply, never an emission.

## Skeleton

```yaml skeleton
id: {{id}}
symbol: {{symbol}}
name: {{name}}
chain: {{chain}}

contracts:
  token: "{{token_address}}"
  reserve: "{{reserve_address}}"                 # holds the converted fees
  fee_converter: "{{fee_converter_address}}"     # converts fees to the token: the reserve's only paying sender
  release_wallet: "{{release_wallet_address}}"   # releases non-circulating supply (dilution)

ingest: { chain_id: {{chain_id}}, rpc_url_env: {{rpc_url_env}}, backfill_days: 100 }

external_ids:
  coingecko: {{coingecko_id}}

metrics:
  price_usd:
    type: level
    unit: usd
    staleness_days: 3
    critical: true
    # The token's entry in prices.yaml (repo root) names its method and its check; add the entry there first (a ref
    # with no entry is refused at load). No CoinGecko price is read (Phase 3 R2).
    source: { type: adapter, name: price.token, params: { ref: "{{price_ref}}" } }
    cross_checks:
      - { tolerance_pct: 2, source: { type: adapter, name: price.token_check, params: { ref: "{{price_ref}}" } } }

  total_supply:
    type: level
    unit: tokens
    staleness_days: 7
    critical: true
    source: { type: erc20_supply, token: token }

  # On chain (Phase 3 R3: no CoinGecko field loads): start from total_supply's read and subtract every holder that is
  # not circulating (a treasury, an unvested allocation, a cited locked_schedule), each a named `contracts:` entry with
  # its citation (chain.view_sum terms; on Solana, solana.supply_less_owners). Staking with an exit stays circulating.
  circulating_supply:
    type: level
    unit: tokens
    staleness_days: 14
    source: { type: erc20_supply, token: token }

  staked_supply:
    type: level
    unit: tokens
    staleness_days: 7
    source: { type: constant, value: 0, note: "{{staked_note}}" }

  emission_rate_annual:
    type: schedule
    unit: tokens_per_year
    staleness_days: 45
    critical: true
    source: { type: constant, value: 0, note: "{{emission_note}}" }

  # The holder flow: converted fees into the reserve, at each hour's chain price (prices.yaml).
  flow_usd.reserve:
    type: flow
    unit: usd
    cadence: daily
    staleness_days: 10
    critical: true
    source: { type: transfer_flow, token: token, to: reserve, from_allowlist: [ fee_converter ], ignore_below_tokens: {{dust_floor_tokens}}, unit: usd }
  flow_tokens.reserve:
    type: flow
    unit: tokens
    cadence: daily
    staleness_days: 10
    monitor_only: true
    source: { type: transfer_flow, token: token, to: reserve, from_allowlist: [ fee_converter ], ignore_below_tokens: {{dust_floor_tokens}}, unit: tokens }
  reserve_tokens: { type: level, unit: tokens, staleness_days: 7, monitor_only: true, source: { type: contract_read, contract: token, function: balanceOf, args: [ reserve ], decimals: 18 } }

  # Releases of non-circulating supply, trailing 365 days (the report's dilution).
  flow_tokens.released:
    type: flow
    unit: tokens
    cadence: daily
    staleness_days: 120
    monitor_only: true
    source: { type: transfer_flow, token: token, to: release_wallet, from_any: true, ignore_below_tokens: 1000, unit: tokens }
  released_rate: { type: level, unit: tokens_per_year, staleness_days: 120, monitor_only: true, source: { type: derived, name: flow_annualized, params: { metric: flow_tokens.released, days: 365 } } }

income_statement:
  category: oracle
  scope: protocol_share_only
  window_days: 91
  revenue:
    - { id: onchain_fees, label: "on-chain service fees converted to the token", metric: flow_usd.reserve, settlement: daily }
  cost_of_revenue:
    - { id: node_operators, to: node_operators, not_measured: "{{cost_not_measured}}" }
  holders:
    - { id: reserve, of: onchain_fees, bucket: hold, haircut: {{hold_haircut}}, recipient_base: all, capture_rule: {{capture_rule}}, note: "fees converted to the token and held" }
  dilution:
    - { id: releases, metric: released_rate, note: "releases from non-circulating wallets (trailing 365 days)" }
  checks:
    - { id: price_chainlink, type: price, level: price_usd, against: price.token_check, tolerance_pct: 2 }
    - { id: reserve_balance, type: balance, level: reserve_tokens, inflows: [ flow_tokens.reserve ], outflows: [], tolerance_pct: 1, tolerance_abs: {{dust_floor_tokens}} }
```

## Example values

LINK's contracts from `assets/link.yaml` (`release_wallet` = the release hub).

```yaml example-values
id: link-t8-example
symbol: LINK
name: Chainlink (T8 example)
chain: ethereum
token_address: "0x514910771AF9Ca656af840dff83E8264EcF986CA"
reserve_address: "0x9A709B7B69EA42D5eeb1ceBC48674C69E1569eC6"
fee_converter_address: "0x5680681ED3767B96914CE741a308155C7fB9171d"
release_wallet_address: "0x9b1c1752b6b6eaf62a8c491a8681b32c1f7ecde9"
chain_id: 1
rpc_url_env: ORION_ETH_RPC_URL
coingecko_id: chainlink
price_ref: "eip155:1/0x514910771af9ca656af840dff83e8264ecf986ca"
staked_note: "staking rewards come from the protocol's allocation, not fees"
emission_note: "1B minted at launch; releases move tokens already in total supply"
dust_floor_tokens: 10
capture_rule: discretionary
cost_not_measured: "fees paid to node operators (CCIP fee tokens, off-chain Data Feeds): not read yet (Phase 3)"
hold_haircut: 0.05
```

## Scoping checklist

1. Category `oracle` (or the service's category), template T8.
2. Every line with its rung and contract: converter → reserve; the service contracts for the cost lines.
3. Licence: the RPC's row only.
4. `not_measured` lines and why: node-operator payments; off-chain revenue (disclosure only).
5. Checks: the `balance` check measured by hand over 30 days (no outflow expected).
6. Supply: total from `totalSupply()`; circulating on chain (total less the non-circulating holders); releases as `dilution`.
7. Imminent events: new fee routes into the converter, reserve withdrawals, staking changes.
8. Expected figures re-measured once by hand: 91 days of reserve inflow, in USD and tokens.
