# T2 exchange buyback

**Examples:** HYPE, LIT, dYdX, GMX-like. **Category:** `perp_dex`. **Example values:** LIT (`assets/lit.yaml`).

An exchange charges trading fees (read from its own API, or from fee-account state) and spends part of them buying its
token, which is burned or held (spec §10 for the bucket). Partner instances (a white-label exchange sharing fees) add a
revenue line and a partner cost.

## Lines

| Section | Line | Rung / source | Notes |
|---|---|---|---|
| revenue | `core` | `first_party_api`: a fees adapter (exchange metrics summed per UTC day) | gross user-paid fees, incl. builder/referral shares |
| revenue | `partner` | the same adapter on the partner instance's API; `started` dates it | young streams stay out of the ex-new growth |
| cost_of_revenue | `partner_share` | `of: partner`, `share`, `share_metric` read from the protocol | LP/vault share, builders, referrers, deployers: `not_measured` until read |
| holders | `buyback` | `first_party_api`: the treasury's fills, per UTC day | bucket `burn` or `hold` (§10) |
| protocol | remainder | `remainder: protocol` | revenue less the rest |

## Addresses and endpoints to find

- The exchange API (operator, rate limits, how far back it keeps trades and metrics), and every partner instance's.
- The treasury / fee account and the market it buys on; the wallet the bought tokens go to.
- Where the burn happens (the sink, and the sender that sends each burn).
- Where the partner split is stated by the protocol itself (an app constant, a contract), never a stats page that
  applies it (a circular check).
- A price reading off the exchange's own book for the price cross-check. CoinGecko id.

## Checks

- `revision`: a fee day as first stored vs the row in force after the adapter's re-reads (an API restating history).
- `parameter` (automatic, from `share_metric`): the partner split the protocol states vs the share the cost line assumes.
- `two_path`: the treasury's fills vs the change in its token balance on the exchange — needs `balance_delta`
  (Phase 3).

## Traps

- APIs revise history and keep only a few months of trades: backfill before it ages out, and add the `revision` check.
- Partner instances are separate exchanges with their own fee accounts; one may not buy back at all.
- Fees are in the quote asset (USDC/USDG): the adapter reports USD (`usdNative`), so no price is applied.
- A buyback-and-burn whose burned tokens come from a reserve (not the bought tokens) is one flow on a total-supply
  basis: count the buys, not the burns.
- A new exchange needs its own bespoke adapter (first-party APIs are the one place bespoke code is allowed), until a
  generic `api_series` exists.

## Skeleton

```yaml skeleton
id: {{id}}
symbol: {{symbol}}
name: {{name}}
chain: {{chain}}

contracts:
  token: "{{token_address}}"             # the token on L1; burns go to dead
  dead: "{{dead_address}}"
  burn_sender: "{{burn_sender_address}}" # sends each burn to dead

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
      - { tolerance_pct: 2, source: { type: http_json, url: "{{price_api_url}}", path: {{price_api_path}} } }

  total_supply:
    type: level
    unit: tokens
    staleness_days: 7
    critical: true
    source: { type: erc20_supply, token: token, subtract_balances: [ dead ] }
    cross_checks:
      - { tolerance_pct: 2.5, source: { type: coingecko, id: {{coingecko_id}}, field: total_supply } }

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

  # Revenue: the exchange's own fee metrics, per completed UTC day, gross.
  flow_usd.fees_core:
    type: flow
    unit: usd
    cadence: daily
    staleness_days: 5
    monitor_only: true
    source: { type: adapter, name: {{fees_adapter}}, params: {{fees_params}} }
  flow_usd.fees_partner:
    type: flow
    unit: usd
    cadence: daily
    staleness_days: 5
    monitor_only: true
    source: { type: adapter, name: {{fees_adapter}}, params: {{partner_fees_params}} }
  # needs api_series (Phase 3): a generic first-party daily JSON series with revision_days, in place of a bespoke adapter

  # The partner split as the protocol states it (the cost line's share_metric); a reading off the share is watched.
  partner_revenue_share:
    type: level
    unit: ratio
    staleness_days: 3
    monitor_only: true
    source: { type: adapter, name: {{partner_share_adapter}} }
    watch: { outside: [ {{partner_share}}, {{partner_share}} ] }

  # The holder flow: what the treasury spends on the token each completed UTC day (its fills).
  flow_usd.buyback:
    type: flow
    unit: usd
    cadence: daily
    staleness_days: 4
    critical: true
    source: { type: adapter, name: {{buys_adapter}}, params: {{buys_usd_params}} }
  flow_tokens.buyback:
    type: flow
    unit: tokens
    cadence: daily
    staleness_days: 4
    monitor_only: true
    source: { type: adapter, name: {{buys_adapter}}, params: {{buys_tokens_params}} }

  # The burns as executed (report-only): any other sender raises an unlisted anomaly.
  flow_tokens.burn:
    type: flow
    unit: tokens
    cadence: daily
    staleness_days: 120
    monitor_only: true
    source: { type: transfer_flow, token: token, to: dead, from_allowlist: [ burn_sender ], unit: tokens }
  # needs balance_delta (Phase 3): treasury_token_balance_change, the treasury's token balance change on the exchange per day

holder_flows:
  - { id: buyback, kind: burn, capture_rule: {{capture_rule}}, recipient_base: all, metric: flow_usd.buyback, window_days: 91 }

income_statement:
  category: perp_dex
  scope: complete
  window_days: 91
  revenue:
    - { id: core, label: "exchange fees (first-party API)", metric: flow_usd.fees_core, settlement: daily }
    - { id: partner, label: "partner-instance fees (first-party API)", metric: flow_usd.fees_partner, settlement: daily, started: "{{partner_started}}" }
  cost_of_revenue:
    - { id: partner_share, to: partners, of: partner, share: {{partner_share}}, share_metric: partner_revenue_share }
    - { id: liquidity_providers, to: lps, not_measured: "{{lp_not_measured}}" }
  holders:
    - { id: buyback, metric: flow_usd.buyback, bucket: burn, haircut: 0, recipient_base: all, capture_rule: {{capture_rule}} }
  remainder: protocol
  volume: [ flow_usd.fees_core, flow_usd.fees_partner ]
  burned_tokens: [ flow_tokens.buyback ]
  checks:
    - { id: fees_core_revision, type: revision, metric: flow_usd.fees_core, days: 3, tolerance_pct: 0.01 }
    # needs balance_delta (Phase 3): { id: buys_vs_balance, type: two_path, a: flow_tokens.buyback, b: treasury_token_balance_change, window_days: 7, tolerance_pct: 1 }
```

## Example values

LIT's contracts, adapters and params from `assets/lit.yaml` (`partner` = the Robinhood instance).

```yaml example-values
id: lit-t2-example
symbol: LIT
name: Lighter (T2 example)
chain: ethereum
token_address: "0x232CE3bd40fCd6f80f3d55A522d03f25Df784Ee2"
dead_address: "0x000000000000000000000000000000000000dEaD"
burn_sender_address: "0x3dd7c834eaa70c98e1c224808a3c62163b344dae"
chain_id: 1
rpc_url_env: ORION_ETH_RPC_URL
coingecko_id: lighter
price_api_url: "https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails?market_id=2049"
price_api_path: spot_order_book_details.0.last_trade_price
staked_note: "staking rewards are bought LIT passed on, not a fee share"
emission_note: "1B minted at launch"
fees_adapter: lit.exchange_fees_daily
fees_params: "{ kinds: [ maker_fee, taker_fee, transfer_fee, withdraw_fee ] }"
partner_fees_params: '{ api: "https://api.rh.lighter.xyz/api/v1", kinds: [ maker_fee, taker_fee, transfer_fee, withdraw_fee ] }'
partner_share_adapter: lit.app_fee_share
partner_share: 0.5
buys_adapter: lit.treasury_buys_daily
buys_usd_params: "{ account: 0, market: 2049, unit: usd, days: 7 }"
buys_tokens_params: "{ account: 0, market: 2049, unit: tokens, days: 7 }"
capture_rule: discretionary
partner_started: "2026-06-26"
lp_not_measured: "liquidity pool share of fees: not in the fee metrics read"
```

## Scoping checklist

1. Category `perp_dex`, template T2; bucket burn or hold (spec §10).
2. Every line with its rung and endpoint: fee kinds summed, partner instances, the fills, the burn route.
3. Licence: every exchange host (core, partner, app, explorer) in `docs/ops/sources-register.md`; `unknown` blocks the
   site export only.
4. `not_measured` lines and why: LP/vault share, builder fees, referral rebates, deployer shares unless the API states
   them.
5. Checks: the `revision` depth equals the adapter's re-read depth; the partner split read at its source.
6. Supply: total = minted less dead; circulating from CoinGecko; unlocks as `dilution` (a cited schedule).
7. Imminent events: fee changes, new instances, token migrations.
8. Expected figures re-measured once by hand: 91 days of fees by kind, the fills, the burns.
