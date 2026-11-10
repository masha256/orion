# T7 lending market

**Examples:** Aave, Compound, Morpho, Spark. **Category:** `lending`. **Example values:** all **dummy** (no live
lending asset on this branch); the shape follows an Aave-style market.

Borrowers pay interest; lenders receive it less the reserve factor, which accrues to the protocol's collector (minted
as interest-bearing market tokens). The protocol may spend part of its take buying its token.

## Lines

| Section | Line | Rung / source | Notes |
|---|---|---|---|
| revenue | `borrow_interest` | `derived` from the collector's reserve-factor accrual ÷ the reserve factor, `share_metric` read daily | one line per market; gross = what borrowers pay |
| cost_of_revenue | `lenders` | `of: borrow_interest`, share = 1 − reserve factor | |
| holders | `buyback` | `log_scan`: tokens the buyback route delivers | bucket `hold` (bought and kept) or `burn` |
| protocol | remainder | `remainder: protocol` | the reserve factor less the buyback |

The accrual today is a `log_scan` of market-token mints into the collector (`transfer_flow` from the zero address).
A direct read of `accruedToTreasury` × the liquidity index per day needs `state_delta` (Phase 3).

## Addresses and endpoints to find

- Per market: the market token (aToken / cToken), its underlying, the reserve-factor read (data provider or market
  config), and the collector.
- The protocol token, its buyback route (who sends the bought tokens, where they go).
- Flash-loan fee recipients (a separate revenue line if they accrue apart).
- A Chainlink feed for the token. CoinGecko ids (token, each underlying).

## Checks

- `parameter` (automatic, from the revenue line's `share_metric`): the market's reserve factor vs the assumed one.
- `price`: CoinGecko vs the Chainlink feed.
- `balance` on the collector is **not** usable with a `contract_read` balance: interest-bearing balances grow without
  transfers. A `state_delta` of the scaled balance is needed (Phase 3).

## Traps

- Reserve factors are per market and change by governance: one revenue line and share read per market (suffix the
  metric keys: `flow_usd.accrual.usdc`).
- Mints to the collector happen when the protocol calls `mintToTreasury`, not daily: the daily series is lumpy; the
  91-day window absorbs it.
- Flash-loan premiums and liquidation fees are separate streams.
- Incentive emissions to borrowers/lenders are the token's dilution, not a cost of revenue.

## Skeleton

```yaml skeleton
id: {{id}}
symbol: {{symbol}}
name: {{name}}
chain: {{chain}}

contracts:
  token: "{{token_address}}"
  zero: "0x0000000000000000000000000000000000000000"   # market tokens are minted to the collector
  collector: "{{collector_address}}"                   # receives the reserve factor
  market_token: "{{market_token_address}}"             # the interest-bearing token of one market
  underlying: "{{underlying_address}}"                 # that market's underlying asset
  reserve_config: "{{reserve_config_address}}"         # states each market's reserve factor
  buyback_source: "{{buyback_source_address}}"         # sends the bought tokens
  buyback_sink: "{{buyback_sink_address}}"             # where bought tokens are kept
  chainlink_price: "{{chainlink_feed_address}}"

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
    cross_checks:
      - { tolerance_pct: 2, source: { type: contract_read, contract: chainlink_price, function: latestAnswer, decimals: 8 } }

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

  # The reserve factor's accrual: market tokens minted into the collector, priced as the underlying.
  flow_usd.accrual:
    type: flow
    unit: usd
    cadence: daily
    staleness_days: 30
    monitor_only: true
    source: { type: transfer_flow, token: market_token, to: collector, from_allowlist: [ zero ], unit: usd, price_coingecko_id: {{underlying_coingecko_id}} }

  # The market's reserve factor, read daily (the revenue line's share_metric).
  reserve_factor:
    type: level
    unit: ratio
    staleness_days: 7
    monitor_only: true
    source: { type: contract_read, contract: reserve_config, function: {{reserve_factor_function}}, args: [ underlying ], decimals: {{reserve_factor_decimals}} }

  flow_usd.buyback:
    type: flow
    unit: usd
    cadence: daily
    staleness_days: 30
    critical: true
    source: { type: transfer_flow, token: token, to: buyback_sink, from_allowlist: [ buyback_source ], unit: usd, price_coingecko_id: {{coingecko_id}} }

  # needs state_delta (Phase 3): flow_usd.accrued_to_treasury, accruedToTreasury x the liquidity index, per day per market
  # needs state_delta (Phase 3): flow_usd.borrow_interest, Σ debt x Δ borrow index per day (a measured gross)

income_statement:
  category: lending
  scope: complete
  window_days: 91
  revenue:
    - { id: borrow_interest, label: "borrower interest (reserve-factor accrual / reserve factor)", derived: { from: flow_usd.accrual, share: {{reserve_factor}}, share_metric: reserve_factor } }
  cost_of_revenue:
    - { id: lenders, to: lenders, of: borrow_interest, share: {{lender_share}} }
  holders:
    - { id: buyback, metric: flow_usd.buyback, bucket: hold, haircut: {{hold_haircut}}, recipient_base: all, capture_rule: {{capture_rule}} }
  remainder: protocol
  checks:
    - { id: price_chainlink, type: price, level: price_usd, against: chainlink_price, tolerance_pct: 2 }
    # needs state_delta (Phase 3): { id: accrual_two_path, type: two_path, a: flow_usd.accrual, b: flow_usd.accrued_to_treasury, window_days: 30, tolerance_pct: 2 }
```

## Example values

All **dummy**: placeholder addresses and ids so the skeleton is parse-tested. Replace every value when onboarding.

```yaml example-values
id: lending-t7-example
symbol: LEND
name: Lending market (T7 dummy example)
chain: ethereum
token_address: "0x00000000000000000000000000000000000007a1"
collector_address: "0x00000000000000000000000000000000000007a2"
market_token_address: "0x00000000000000000000000000000000000007a3"
underlying_address: "0x00000000000000000000000000000000000007a4"
reserve_config_address: "0x00000000000000000000000000000000000007a5"
buyback_source_address: "0x00000000000000000000000000000000000007a6"
buyback_sink_address: "0x00000000000000000000000000000000000007a7"
chainlink_feed_address: "0x00000000000000000000000000000000000007a8"
chain_id: 1
rpc_url_env: ORION_ETH_RPC_URL
coingecko_id: dummy-lending-token
underlying_coingecko_id: usd-coin
staked_note: "safety-module staking pays emissions, not a fee share"
emission_note: "no minting; incentive emissions from the treasury are dilution"
reserve_factor_function: getReserveFactor
reserve_factor_decimals: 4
reserve_factor: 0.1
lender_share: 0.9
hold_haircut: 0.05
capture_rule: discretionary
```

## Scoping checklist

1. Category `lending`, template T7; which markets carry most of the interest (list each, with coverage stated).
2. Every line with its rung and contract: per-market accrual, reserve-factor read, buyback route.
3. Licence: the RPC's row; any first-party API (none expected).
4. `not_measured` lines and why: markets not listed, flash-loan fees until read.
5. Checks: each market's reserve factor equals the configured share today.
6. Supply: total from `totalSupply()`; circulating from CoinGecko; treasury incentive programs as `dilution`.
7. Imminent events: reserve-factor votes, new market versions (v3 → v4), buyback programme changes.
8. Expected figures re-measured once by hand: 91 days of collector mints per market.
