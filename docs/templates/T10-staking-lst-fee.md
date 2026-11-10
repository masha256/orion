# T10 staking / LST fee

**Examples:** Lido, Jito, Rocket Pool. **Category:** `lst`. **Example values:** all **dummy** (no live LST asset on
this branch); the shape follows a Lido-style rebasing LST.

Stakers deposit the base asset; validators earn rewards; the protocol takes a fee on the rewards (split between its
treasury and node operators) by minting LST shares to them at each oracle report. Revenue = the total staking rewards
users' deposits earn; stakers' share and node operators are the cost of revenue.

## Lines

| Section | Line | Rung / source | Notes |
|---|---|---|---|
| revenue | `staking_rewards` | `derived` from the treasury's fee mints ÷ the treasury's fee share, `share_metric` read daily | a measured total from oracle reports needs `state_delta` (Phase 3) |
| cost_of_revenue | `stakers` | `of: staking_rewards`, share = 1 − total fee | |
| cost_of_revenue | `node_operators` | `log_scan`: fee mints to the node-operator module | |
| holders | none | no `holders` section | Lido's token receives nothing: see the holder-flow trap |
| protocol | remainder | `remainder: protocol` | the treasury's fee |

## Addresses and endpoints to find

- The LST token (rebasing or share-based), the treasury, the node-operator module(s), the zero address the fee shares
  are minted from.
- The fee read (total fee, treasury share, operator share), as fractions.
- The oracle that reports rewards (for the Phase 3 `state_delta`).
- The protocol token and any buyback route (a `holders` line if one exists). CoinGecko ids (protocol token, the LST
  or the base asset).

## Checks

- `parameter` (automatic, from the revenue line's `share_metric`): the treasury's fee share vs the assumed share.
- `parameter`: the node-operator share read vs its configured value.
- `two_path`: the derived rewards vs the oracle-reported rewards — needs `state_delta` (Phase 3).

## Traps

- MEV and priority fees: some protocols report them apart from consensus rewards; check what the fee applies to.
- A rebasing LST's balances grow without transfers: never use a `balance` check on a holder of it.
- **The protocol token may receive nothing** (Lido today). Since Task 11 retired `holder_flows` an asset needs no holder
  flow: leave out the `holders` section and the yields read zero. Add a `holders` line (a `log_scan` of the route) only
  for a protocol whose token is bought back or paid.
- Fee mints happen once per oracle report (daily on Lido): a missed report shows as a zero day, not a cut fee.

## Skeleton

```yaml skeleton
id: {{id}}
symbol: {{symbol}}
name: {{name}}
chain: {{chain}}

contracts:
  token: "{{token_address}}"                         # the protocol (governance) token
  lst: "{{lst_address}}"                             # the liquid staking token
  zero: "0x0000000000000000000000000000000000000000" # fee shares are minted
  treasury: "{{treasury_address}}"
  node_operators: "{{node_operators_address}}"       # the node-operator module that receives its fee shares
  fee_config: "{{fee_config_address}}"               # states the fee split

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

  # The treasury's fee: LST minted to it at each oracle report, priced as the LST.
  flow_usd.treasury_fee:
    type: flow
    unit: usd
    cadence: daily
    staleness_days: 5
    monitor_only: true
    source: { type: transfer_flow, token: lst, to: treasury, from_allowlist: [ zero ], unit: usd, price_coingecko_id: {{lst_coingecko_id}} }
  flow_usd.node_operator_fee:
    type: flow
    unit: usd
    cadence: daily
    staleness_days: 5
    monitor_only: true
    source: { type: transfer_flow, token: lst, to: node_operators, from_allowlist: [ zero ], unit: usd, price_coingecko_id: {{lst_coingecko_id}} }

  # The fee split as the protocol states it, as fractions of rewards.
  treasury_fee_share: { type: level, unit: ratio, staleness_days: 7, monitor_only: true, source: { type: contract_read, contract: fee_config, function: {{treasury_fee_function}}, decimals: {{fee_decimals}} } }
  node_operator_fee_share: { type: level, unit: ratio, staleness_days: 7, monitor_only: true, source: { type: contract_read, contract: fee_config, function: {{operator_fee_function}}, decimals: {{fee_decimals}} } }

  # needs state_delta (Phase 3): flow_usd.reported_rewards, the oracle-reported rewards (pooled-asset delta) per day

income_statement:
  category: lst
  scope: complete
  window_days: 91
  revenue:
    - { id: staking_rewards, label: "staking rewards (treasury fee / treasury share)", derived: { from: flow_usd.treasury_fee, share: {{treasury_fee_share}}, share_metric: treasury_fee_share } }
  cost_of_revenue:
    - { id: stakers, to: other, label: "stakers' share of rewards", of: staking_rewards, share: {{stakers_share}} }
    - { id: node_operators, to: node_operators, metric: flow_usd.node_operator_fee }
  remainder: protocol
  checks:
    - { id: node_operator_share, type: parameter, metric: node_operator_fee_share, expected: {{node_operator_fee_share}}, tolerance_pct: 0 }
    # needs state_delta (Phase 3): { id: rewards_two_path, type: two_path, a: <staking_rewards gross>, b: flow_usd.reported_rewards, window_days: 7, tolerance_pct: 2 }
```

## Example values

All **dummy**: placeholder addresses and ids so the skeleton is parse-tested (fee split 5 / 5 / 90 as Lido's
published one). Replace every value when onboarding.

```yaml example-values
id: lst-t10-example
symbol: STK
name: Staking protocol (T10 dummy example)
chain: ethereum
token_address: "0x0000000000000000000000000000000000000a01"
lst_address: "0x0000000000000000000000000000000000000a02"
treasury_address: "0x0000000000000000000000000000000000000a03"
node_operators_address: "0x0000000000000000000000000000000000000a04"
fee_config_address: "0x0000000000000000000000000000000000000a05"
chain_id: 1
rpc_url_env: ORION_ETH_RPC_URL
coingecko_id: dummy-staking-token
lst_coingecko_id: dummy-lst
staked_note: "no fee share to stakers of the protocol token"
emission_note: "no minting"
treasury_fee_function: treasuryFee
operator_fee_function: nodeOperatorFee
fee_decimals: 4
treasury_fee_share: 0.05
stakers_share: 0.9
node_operator_fee_share: 0.05
```

## Scoping checklist

1. Category `lst`, template T10; does the protocol token receive anything (else see the holder-flow trap)?
2. Every line with its rung and contract: fee mints to treasury and operators; the fee read; the oracle.
3. Licence: the RPC's row; any first-party API (validator sets, MEV reports).
4. `not_measured` lines and why: MEV/priority-fee shares if reported apart.
5. Checks: both fee shares equal the configured ones today.
6. Supply: total from `totalSupply()`; circulating from CoinGecko; treasury programs as `dilution`.
7. Imminent events: fee-split votes, new staking modules, withdrawal-queue changes.
8. Expected figures re-measured once by hand: 30 days of fee mints vs the oracle reports.
