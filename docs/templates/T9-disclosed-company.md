# T9 disclosed company

**Examples:** VVV. **Category:** `ai_platform` (or the company's business). **Example values:** VVV (`assets/vvv.yaml`,
Base).

A company sells a product off chain and states its revenue (an annual run rate) in cited disclosures; part of it buys
and burns (or holds) the token on chain. Revenue is the disclosure; what reaches holders is measured.

## Lines

| Section | Line | Rung / source | Notes |
|---|---|---|---|
| revenue | `business` | `disclosure`: a manual level entered with `data set ... --citation --quote` | the only revenue line (schema rule) |
| cost_of_revenue | `compute` (or the business's main cost) | disclosure | `not_measured` unless disclosed |
| holders | `burn` | `log_scan`: the burn sink's inflows from the burning contracts | bucket `burn` (or `hold`) |
| protocol | remainder | `remainder: protocol` | revenue less the rest, before undisclosed costs |

A disclosure cannot be reconciled, only flagged: a monitor-only usage series (here, the momentum of the programmatic
burns) carries a `watch`, so a large move in on-chain usage with no new disclosure is reported.

## Addresses and endpoints to find

- The token, the burn sink, every burner (programmatic per-use burns vs discretionary buybacks: `count_from` splits
  them on one scan).
- The staking contract (staked supply, the emission rate read).
- The company's disclosure channels (calls, posts, reports) for each run-rate update; record citation and quote.
- CoinGecko id; the company's own app API, if any, as a cross-check only (and its register row).

## Checks

- `supply`: the day's fall in `total_supply` vs the scanned burns (catches burns outside the sink).
- `watch` on the monitor-only usage series (not a check: a fetch-time report, never an anomaly).

## Traps

- Stale disclosures: the run rate ages; set `staleness_days` to the disclosure cadence and re-enter on each new figure.
- Never mix the disclosure with a proxy series (a third-party revenue estimate) in revenue.
- `revenue_run_rate_usd` is a standard metric, so it cannot be monitor-only or watched itself; watch a separate
  usage series.
- Emissions to stakers are dilution against the burn: read the rate from the staking contract.

## Skeleton

```yaml skeleton
id: {{id}}
symbol: {{symbol}}
name: {{name}}
chain: {{chain}}

contracts:
  token: "{{token_address}}"
  staking: "{{staking_address}}"                     # staked token; the emission rate
  burn_sink: "{{burn_sink_address}}"
  programmatic_burner: "{{programmatic_burner_address}}" # per-use burns (the usage signal)
  buyback_burner: "{{buyback_burner_address}}"       # discretionary buybacks

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

  # The company's disclosed annual run rate: entered by hand with a citation and quote (no source).
  revenue_run_rate_usd: { type: level, unit: usd, cadence: event, staleness_days: {{disclosure_staleness_days}}, critical: true }

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
    source: { type: contract_read, contract: staking, function: totalSupply, decimals: 18 }

  emission_rate_annual:
    type: schedule
    unit: tokens_per_year
    cadence: event
    staleness_days: 45
    critical: true
    source: { type: contract_read, contract: staking, function: {{emission_function}}, decimals: 18, scale: 31536000 }

  # The holder flow: every burn from the listed burners, at each day's price.
  flow_usd.burn:
    type: flow
    unit: usd
    cadence: daily
    staleness_days: 4
    critical: true
    source: { type: transfer_flow, token: token, to: burn_sink, from_allowlist: [ programmatic_burner, buyback_burner ], unit: usd, price_coingecko_id: {{coingecko_id}} }
  flow_tokens.burn:
    type: flow
    unit: tokens
    cadence: daily
    staleness_days: 4
    monitor_only: true
    source: { type: transfer_flow, token: token, to: burn_sink, from_allowlist: [ programmatic_burner, buyback_burner ], unit: tokens }
  # The programmatic burns alone (one scan, count_from): the on-chain usage signal.
  flow_usd.burn_programmatic:
    type: flow
    unit: usd
    cadence: daily
    staleness_days: 4
    monitor_only: true
    source: { type: transfer_flow, token: token, to: burn_sink, from_allowlist: [ programmatic_burner, buyback_burner ], count_from: [ programmatic_burner ], unit: usd, price_coingecko_id: {{coingecko_id}} }
  # Usage momentum, watched: a move this large with no new disclosure is reported (never an anomaly).
  usage_watch:
    type: level
    unit: usd_per_day
    staleness_days: 7
    monitor_only: true
    source: { type: derived, name: burn_momentum, params: { metric: flow_usd.burn_programmatic, days: 30 } }
    watch: { change_pct: {{usage_watch_pct}} }

income_statement:
  category: {{category}}
  scope: complete
  window_days: 91
  revenue:
    - { id: business, label: "disclosed business revenue (annual run rate)", disclosed: revenue_run_rate_usd }
  cost_of_revenue:
    - { id: main_cost, to: other, not_measured: "{{cost_not_measured}}" }
  holders:
    - { id: burn, metric: flow_usd.burn, bucket: burn, haircut: 0, recipient_base: all, capture_rule: {{capture_rule}} }
  remainder: protocol
  burned_tokens: [ flow_tokens.burn ]
  checks:
    - { id: burn_supply, type: supply, level: total_supply, burns: [ flow_tokens.burn ], tolerance_pct: 1, tolerance_abs: {{supply_tolerance_tokens}} }
```

## Example values

VVV's contracts from `assets/vvv.yaml` (`programmatic_burner` = the Aerodrome pool's per-use burns, `buyback_burner`
= the buyback Safe).

```yaml example-values
id: vvv-t9-example
symbol: VVV
name: Venice Token (T9 example)
chain: base
token_address: "0xacfE6019Ed1A7Dc6f7B508C02d1b04ec88cC21bf"
staking_address: "0x321b7ff75154472B18EDb199033fF4D116F340Ff"
burn_sink_address: "0x0000000000000000000000000000000000000000"
programmatic_burner_address: "0x01784ef301D79e4B2DF3a21ad9a536d4cF09A5Ce"
buyback_burner_address: "0x35FB3b67C57849bF57eB24B061EeF0b5e560DC57"
chain_id: 8453
rpc_url_env: ORION_BASE_RPC_URL
coingecko_id: venice-token
disclosure_staleness_days: 90
emission_function: emissionRatePerSecond
usage_watch_pct: 25
capture_rule: discretionary
category: ai_platform
cost_not_measured: "compute costs: not disclosed"
supply_tolerance_tokens: 1
```

## Scoping checklist

1. Category (the business), template T9; burn or hold.
2. Every line with its rung: the disclosure source and cadence; the burn sink and burners.
3. Licence: the RPC's row; any company API used as a cross-check.
4. `not_measured` lines and why: costs the company does not disclose.
5. Checks: the `supply` check measured by hand over 30 days; the usage watch threshold set from 6 months of history.
6. Supply: total = on-chain less the sink; circulating from CoinGecko; staker emissions from the staking contract.
7. Imminent events: new products, burn-policy changes, the next scheduled disclosure.
8. Expected figures re-measured once by hand: the latest run rate with its quote; 91 days of burns.
