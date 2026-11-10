# T4 ve distribution

**Examples:** CRV, AERO, VELO, Balancer. **Category:** `dex` (CRV also runs a CDP; tag the main business).
**Example values:** CRV (`assets/crv.yaml`).

The protocol takes an admin share of swap (and borrow) fees and distributes it to vote-escrow lockers through a fee
distributor; a splitter may keep part for the treasury. Third parties also pay lockers for votes (bribes): that income
is **below the line** (users did not pay it).

## Lines

| Section | Line | Rung / source | Notes |
|---|---|---|---|
| revenue | `fees` | `log_scan`: the allocator's transfers into the fee distributor | admin share; scope `protocol_share_only` |
| revenue | `treasury_rev` | `log_scan`: the allocator's transfers to the treasury | the splitter's kept share |
| cost_of_revenue | `lps` | LP fees (admin × 1/share − admin) | `not_measured`; derivable only where the admin share is one number (decision 7) |
| holders | `ve_fees` | `of: fees`; bucket `cash`, `recipient_base: locked` | |
| protocol | `treasury` | `of: treasury_rev` | |
| below_line | `vote_incentives` | incentive markets (Votemarket, Hidden Hand) | `not_measured` until a curated `pool_scan` (Phase 3); no third-party API |

## Addresses and endpoints to find

- The token (emission schedule), the voting escrow (`supply()` = tokens locked), the fee token.
- The fee route end to end: the contract that sends fees in (hooker / burner), the allocator or splitter, the fee
  distributor, the treasury.
- The emission rate read (per-second rate × seconds a year), or an adapter if epochs cut it on a schedule.
- The incentive markets that pay voters, for the Phase 3 scan. CoinGecko id (and the fee token's).

## Checks

- `sum`: the allocator's inflow vs fees + treasury (a missed recipient, a new split).
- `coverage`: the gauge / incentive-market list vs a protocol total — needs `pool_scan` (Phase 3).
- `price`: a Chainlink feed where one exists (CRV has none on this branch; its `coins.llama.fi` cross-check is dropped
  in Phase 3).

## Traps

- Bribes are third-party vote payments: below the line, never revenue, and never sourced from a community API.
- Fee tokens vary by period (3CRV then crvUSD): pin the token per route and re-check after migrations.
- `staked_supply` and `locked_supply` are the escrowed tokens, not vote power (vote power decays).
- The admin share differs by product (pools, crvUSD controllers, lending markets): split inflows by sender before
  deriving a gross.

## Skeleton

```yaml skeleton
id: {{id}}
symbol: {{symbol}}
name: {{name}}
chain: {{chain}}

contracts:
  token: "{{token_address}}"                     # the token; also the emission schedule
  ve: "{{ve_address}}"                           # voting escrow: supply() is the token locked
  fee_token: "{{fee_token_address}}"             # what the distributor pays in
  fee_source: "{{fee_source_address}}"           # sends every protocol fee to the allocator
  fee_allocator: "{{fee_allocator_address}}"     # splits fees: distributor and treasury
  fee_distributor: "{{fee_distributor_address}}" # pays lockers
  treasury: "{{treasury_address}}"

ingest: { chain_id: {{chain_id}}, rpc_url_env: {{rpc_url_env}}, backfill_days: 100 }

external_ids:
  coingecko: {{coingecko_id}}

metrics:
  price_usd:
    type: level
    unit: usd
    staleness_days: 3
    critical: true
    source: { type: coingecko, id: {{coingecko_id}}, field: price }

  total_supply:
    type: level
    unit: tokens
    staleness_days: 7
    critical: true
    source: { type: erc20_supply, token: token }
    cross_checks:
      - { tolerance_pct: 2, source: { type: coingecko, id: {{coingecko_id}}, field: total_supply } }

  circulating_supply:
    type: level
    unit: tokens
    staleness_days: 14
    source: { type: coingecko, id: {{coingecko_id}}, field: circulating_supply }

  # The tokens locked (not vote power, which decays).
  staked_supply:
    type: level
    unit: tokens
    staleness_days: 7
    source: { type: contract_read, contract: ve, function: supply, decimals: 18 }
  locked_supply:
    type: level
    unit: tokens
    staleness_days: 7
    source: { type: contract_read, contract: ve, function: supply, decimals: 18 }

  # Tokens per second x seconds a year. Epoch cuts on a schedule need an adapter returning schedule_steps (crv.emission_rate_annual).
  emission_rate_annual:
    type: schedule
    unit: tokens_per_year
    staleness_days: 45
    critical: true
    source: { type: contract_read, contract: token, function: {{emission_function}}, decimals: 18, scale: 31536000 }

  # The holder flow: the allocator's fee-token transfers into the distributor.
  flow_usd.fees:
    type: flow
    unit: usd
    cadence: daily
    staleness_days: 10
    critical: true
    source: { type: transfer_flow, token: fee_token, to: fee_distributor, from_allowlist: [ fee_allocator ], unit: usd, price_coingecko_id: {{fee_token_coingecko_id}} }
  flow_usd.treasury:
    type: flow
    unit: usd
    cadence: daily
    staleness_days: 10
    monitor_only: true
    source: { type: transfer_flow, token: fee_token, to: treasury, from_allowlist: [ fee_allocator ], unit: usd, price_coingecko_id: {{fee_token_coingecko_id}} }
  # The allocator's inflow: the total the sum check splits.
  flow_usd.protocol_revenue:
    type: flow
    unit: usd
    cadence: daily
    staleness_days: 10
    monitor_only: true
    source: { type: transfer_flow, token: fee_token, to: fee_allocator, from_allowlist: [ fee_source ], unit: usd, price_coingecko_id: {{fee_token_coingecko_id}} }
  # needs pool_scan (Phase 3): flow_usd.vote_incentives, voter payouts over a curated list of incentive markets, with coverage

income_statement:
  category: dex
  scope: protocol_share_only
  window_days: 91
  revenue:
    - { id: fees, label: "admin fees paid to lockers", metric: flow_usd.fees }
    - { id: treasury_rev, label: "admin fees kept", metric: flow_usd.treasury }
    # Where the admin share is one fixed number (decision 7): a derived gross instead, e.g.
    #   - { id: swap_fees, derived: { from: flow_usd.protocol_revenue, share: 0.5 } }   with lps of: swap_fees, share: 0.5
  cost_of_revenue:
    - { id: lps, to: lps, not_measured: "{{lp_not_measured}}" }
  holders:
    - { id: ve_fees, of: fees, bucket: cash, haircut: 0, recipient_base: locked, capture_rule: programmatic }
  protocol:
    - { id: treasury, of: treasury_rev }
  below_line:
    - { id: vote_incentives, to: holders, not_measured: "third-party vote incentives: needs a pool_scan of the incentive markets (Phase 3)" }
  checks:
    - { id: splitter, type: sum, total: [ flow_usd.protocol_revenue ], parts: [ ve_fees, treasury ], tolerance_pct: 2 }
    # needs pool_scan (Phase 3): { id: incentive_coverage, type: coverage, listed: [ flow_usd.vote_incentives ], total: <a market total>, tolerance_pct: 10 }
```

## Example values

CRV's contracts from `assets/crv.yaml` (`fee_source` = the Hooker).

```yaml example-values
id: crv-t4-example
symbol: CRV
name: Curve DAO Token (T4 example)
chain: ethereum
token_address: "0xD533a949740bb3306d119CC777fa900bA034cd52"
ve_address: "0x5f3b5DfEb7B28CDbD7FAba78963EE202a494e2A2"
fee_token_address: "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E"
fee_source_address: "0x9a9df35cd8e88565694ca6ad5093c236c7f6f69d"
fee_allocator_address: "0x22530d384cd9915e096ead2db7f82ee81f8eb468"
fee_distributor_address: "0xD16d5eC345Dd86Fb63C6a9C43c517210F1027914"
treasury_address: "0x6508ef65b0bd57eabd0f1d52685a70433b2d290b"
chain_id: 1
rpc_url_env: ORION_ETH_RPC_URL
coingecko_id: curve-dao-token
emission_function: rate
fee_token_coingecko_id: crvusd
lp_not_measured: "swap fees to LPs and lender interest: not read yet (Phase 3)"
```

## Scoping checklist

1. Category and template T4; which products pay admin fees.
2. Every line with its rung and contract: the fee route (source → allocator → distributor / treasury).
3. Licence: the RPC's row; no third-party API for bribes (`not_measured` until Phase 3).
4. `not_measured` lines and why: LP fees (unless one admin share), vote incentives.
5. Checks: the `sum` check measured by hand over 30 days (CRV: 0.00 percent gap).
6. Supply: total from `totalSupply()`; circulating from CoinGecko; emissions from the schedule; locked = escrow supply.
7. Imminent events: fee-token migrations, new splitter shares, gauge-system changes.
8. Expected figures re-measured once by hand: 91 days of distributor inflow and treasury share.
