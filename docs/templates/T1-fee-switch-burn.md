# T1 fee-switch burn

**Examples:** UNI, CAKE, SUSHI. **Category:** `dex`. **Example values:** UNI (`assets/uni.yaml`), plus dummy values for
the fee-share read UNI does not have.

A DEX turns on a protocol fee (a fixed share of every swap fee), converts it to its own token and burns it. The burn is
the measured flow; swap fees are derived from it when the share is one fixed number.

## Lines

| Section | Line | Rung / source | Notes |
|---|---|---|---|
| revenue | `swap_fees` | `derived` from the burn flow ÷ the protocol share, `share_metric` read daily | variant (b) below when the share is not uniform |
| cost_of_revenue | `lps` | `of: swap_fees`, share = 1 − protocol share | LP fees; `not_measured` in variant (b) |
| holders | `burn` | `of: swap_fees`, share = protocol share; bucket `burn`, haircut 0 | the measured burn itself |
| protocol | — | — | none unless the converter keeps a cut (then a `metric` line and a `sum` check) |

The burn is a `log_scan` (`transfer_flow` into the burn sink, rung 2). Searchers and bridges burn on the protocol's
behalf, so the scan counts every sender (`from_any: true`) and lists known non-fee burners in `from_ignore` (UNI: the
Timelock's one-off treasury burn).

## Addresses and endpoints to find

- The token, and the sink every fee burn ends in (`0x…dEaD`, or the burner's target).
- Every route into the sink (converters, bridges, searcher contracts): decide `from_any` + `from_ignore` vs a
  `from_allowlist`.
- The contract and function that states the protocol's share of swap fees, as a fraction (a `contract_read`; use
  `decimals`/`scale` to turn bps into a fraction).
- A Chainlink `<SYM>/USD` feed on the token's chain (else a deep pool for the price check).
- CoinGecko id.

## Checks

- `supply`: the day's fall in `total_supply` vs `flow_tokens.burn` (catches burns outside the scanned sink).
- `parameter` (automatic, from the revenue line's `share_metric`): the share read daily vs the share the line assumes.
- `price`: CoinGecko vs the Chainlink feed the price cross-check reads.
- `coverage`: the listed pools' protocol fees vs the burn — needs `pool_scan` (Phase 3).

## Traps

- The share differs by pool or fee tier (UNI v3 selected pools, CAKE v3 tiers): no derivation. Use variant (b):
  revenue = the burn, `scope: protocol_share_only`, `lps` `not_measured`.
- A share stored as a denominator (UNI v3 `feeProtocol` = 1/x) cannot become a fraction with `contract_read` (`scale`
  and `offset` only); that needs a formula source (Phase 3) or a cited `constant` (which a `parameter` check refuses).
- Searchers burn on behalf of the protocol: an allowlist would flag noise; use `from_any`.
- A one-off treasury burn is a supply event, not a flow: put its sender in `from_ignore`.

## Skeleton

```yaml skeleton
id: {{id}}
symbol: {{symbol}}
name: {{name}}
chain: {{chain}}

contracts:
  token: "{{token_address}}"                     # the token; totalSupply() and the burns
  burn_sink: "{{burn_sink_address}}"             # where every fee burn ends
  treasury_burner: "{{treasury_burner_address}}" # a known non-fee burner (one-off treasury burns): ignored
  fee_config: "{{fee_config_address}}"           # states the protocol's share of swap fees
  chainlink_price: "{{chainlink_feed_address}}"  # Chainlink <SYM>/USD, 8 decimals

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

  # On-chain supply less the burn sink (the FDV basis).
  total_supply:
    type: level
    unit: tokens
    staleness_days: 7
    critical: true
    source: { type: erc20_supply, token: token, subtract_balances: [ burn_sink ] }
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
    source: { type: constant, value: 0, note: "no staking: the burn reaches every holder" }

  emission_rate_annual:
    type: schedule
    unit: tokens_per_year
    staleness_days: 45
    critical: true
    source: { type: constant, value: 0, note: "{{emission_note}}" }

  # The holder flow: every token transfer into the sink, at each day's price.
  flow_usd.burn:
    type: flow
    unit: usd
    cadence: daily
    staleness_days: 5
    critical: true
    source: { type: transfer_flow, token: token, to: burn_sink, from_any: true, from_ignore: [ treasury_burner ], unit: usd, price_coingecko_id: {{coingecko_id}} }

  flow_tokens.burn:
    type: flow
    unit: tokens
    cadence: daily
    staleness_days: 5
    monitor_only: true
    source: { type: transfer_flow, token: token, to: burn_sink, from_any: true, from_ignore: [ treasury_burner ], unit: tokens }

  # The protocol's share of swap fees, read daily (the revenue line's share_metric: an automatic parameter check).
  protocol_fee_share:
    type: level
    unit: ratio
    staleness_days: 7
    monitor_only: true
    source: { type: contract_read, contract: fee_config, function: {{fee_share_function}}, decimals: {{fee_share_decimals}} }

  # needs event_sum (Phase 3): flow_usd.swap_fees from a singleton's Swap.fee per day (v4 PoolManager), a measured gross
  # needs pool_scan (Phase 3): flow_usd.listed_protocol_fees over a versioned pool list, for the coverage check

income_statement:
  category: dex
  scope: complete
  window_days: 91
  revenue:
    - { id: swap_fees, label: "swap fees (protocol fees / protocol share)", derived: { from: flow_usd.burn, share: {{protocol_share}}, share_metric: protocol_fee_share } }
    # Variant (b), the share differs by pool or tier: replace the line above with
    #   - { id: protocol_fees, label: "protocol fees", metric: flow_usd.burn, settlement: daily }
    # set scope: protocol_share_only, make lps not_measured, and point the burn line at of: protocol_fees (no share).
  cost_of_revenue:
    - { id: lps, to: lps, of: swap_fees, share: {{lp_share}}, note: "swap fees kept by LPs" }
  holders:
    - { id: burn, of: swap_fees, share: {{protocol_share}}, bucket: burn, haircut: 0, recipient_base: all, capture_rule: {{capture_rule}}, note: "protocol fees bought and burned" }
  burned_tokens: [ flow_tokens.burn ]
  checks:
    - { id: price_chainlink, type: price, level: price_usd, against: chainlink_price, tolerance_pct: 2 }
    - { id: burn_supply, type: supply, level: total_supply, burns: [ flow_tokens.burn ], tolerance_pct: 1, tolerance_abs: {{supply_tolerance_tokens}} }
    # needs pool_scan (Phase 3): { id: pool_coverage, type: coverage, listed: [ flow_usd.listed_protocol_fees ], total: flow_usd.burn, tolerance_pct: 5 }
```

## Example values

UNI's contracts from `assets/uni.yaml`; the share is v2's 1/6 (spec decision 7). `fee_config` and its function are
**dummy** (UNI has no fraction read), and live UNI uses variant (b) because its burn also carries selected v3 pools.

```yaml example-values
id: uni-t1-example
symbol: UNI
name: Uniswap (T1 example)
chain: ethereum
token_address: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984"
burn_sink_address: "0x000000000000000000000000000000000000dEaD"
treasury_burner_address: "0x1a9C8182C09F50C8318d769245beA52c32BE35BC"
fee_config_address: "0x00000000000000000000000000000000000000f1"   # dummy
chainlink_feed_address: "0x553303d460EE0afB37EdFf9bE42922D8FF63220e"
chain_id: 1
rpc_url_env: ORION_ETH_RPC_URL
coingecko_id: uniswap
emission_note: "minter never used"
fee_share_function: protocolFeeShare   # dummy
fee_share_decimals: 18
capture_rule: programmatic
protocol_share: 0.1666667
lp_share: 0.8333333
supply_tolerance_tokens: 1
```

## Scoping checklist

1. Category `dex`, template T1; variant (a) uniform share or (b) per pool/tier.
2. Every line with its rung and contract: the burn sink scan, the share read, (b) which pools the fee switch covers.
3. Licence: no first-party API; the RPC's row in `docs/ops/sources-register.md`.
4. `not_measured` lines and why (variant (b): LP fees until a `pool_scan` or `event_sum` exists).
5. Checks: `supply` and `price` measured by hand over 30 days; the share read equals the assumed share today.
6. Supply: total = on-chain less the sink; circulating from CoinGecko; treasury vests as `dilution`.
7. Imminent events: fee-switch votes, new pool versions, burn-route changes.
8. Expected figures re-measured once by hand (the 91-day burn, in USD and tokens) before launch.
