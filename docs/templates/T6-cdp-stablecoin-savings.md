# T6 CDP stablecoin / savings

**Examples:** SKY, Liquity, crvUSD. **Category:** `cdp_stablecoin`. **Example values:** SKY (`assets/sky.yaml`).

Borrowers pay interest (stability fees) on minted stablecoin; part goes to savers (the savings rate), the protocol keeps
the surplus and pays it to stakers in the stablecoin or spends it buying the token. Reserve yield on deposits is
revenue (spec §11 D2).

## Lines

| Section | Line | Rung / source | Notes |
|---|---|---|---|
| revenue | `surplus_stable` | `log_scan`: stablecoin minted into the stakers' rewards farm | scope `protocol_share_only` until the gross is read |
| revenue | `surplus_buyback` | `log_scan`: tokens the buyback pool pays the treasury | |
| revenue (gross) | stability fees, PSM fees, reserve yield | Vat/controller state Σ debt × Δrate — needs `state_delta` (Phase 3) | |
| cost_of_revenue | `savers` | savings-vault `chi` growth × supply — needs `state_delta` (Phase 3) | `not_measured` until then |
| holders | `stakers`, `buyback` | `of` each surplus line; bucket `cash`, `recipient_base: staked` | the buyback is paid on to stakers |

## Addresses and endpoints to find

- The token, the stablecoin, the staking contract (`totalSupply()` = staked), the stakers' farms.
- The surplus splitter (its `burn` share = the part spent on buybacks), the flapper / buyback route and its pool, the
  treasury that receives bought tokens.
- Treasury top-ups that are not buybacks (ignore them). For Phase 3: the Vat (or controllers), every ilk, the savings
  vault.
- CoinGecko ids (token, stablecoin).

## Checks

- `parameter`: the splitter's buyback share read daily vs the share the config assumes.
- `state_delta` gross fees vs the surplus transfers — needs `state_delta` (Phase 3).
- `price`: a Chainlink or oracle feed where one is readable through Multicall3 (SKY's Chronicle pip reverts).

## Traps

- Reserve / RWA yield on deposits is revenue, labelled "reserve yield" (D2), not below the line.
- Treasury tokens paid to stakers beyond the tokens bought are dilution (`treasury_net_payout`), not holder flow.
- Top-ups from a treasury Safe land where the buybacks land: `from_ignore` them.
- Allocator ilks earn yield outside the stability fee; list each in the Phase 3 gross.

## Skeleton

```yaml skeleton
id: {{id}}
symbol: {{symbol}}
name: {{name}}
chain: {{chain}}

contracts:
  token: "{{token_address}}"
  stable: "{{stable_address}}"                     # the stablecoin
  zero: "0x0000000000000000000000000000000000000000" # the stablecoin is minted straight into the farm
  splitter: "{{splitter_address}}"                 # surplus splitter; burn() is the buyback share
  buyback_pool: "{{buyback_pool_address}}"         # the pool the buybacks pay tokens out of
  treasury: "{{treasury_address}}"                 # receives the bought tokens
  treasury_topup: "{{treasury_topup_address}}"     # a top-up sender, not a buyback: ignored
  staking: "{{staking_address}}"                   # staked token; totalSupply() is the staked amount
  stakers_farm: "{{stakers_farm_address}}"         # pays stakers in the stablecoin

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
    source: { type: contract_read, contract: staking, function: totalSupply, decimals: 18 }

  emission_rate_annual:
    type: schedule
    unit: tokens_per_year
    staleness_days: 45
    critical: true
    source: { type: constant, value: 0, note: "{{emission_note}}" }

  # Surplus paid to stakers in the stablecoin (minted into the farm).
  flow_usd.stakers:
    type: flow
    unit: usd
    cadence: daily
    staleness_days: 10
    critical: true
    source: { type: transfer_flow, token: stable, to: stakers_farm, from_allowlist: [ zero ], unit: usd, price_coingecko_id: {{stable_coingecko_id}} }

  # Surplus spent buying the token: what the pool pays the treasury.
  flow_usd.buyback:
    type: flow
    unit: usd
    cadence: daily
    staleness_days: 10
    critical: true
    source: { type: transfer_flow, token: token, to: treasury, from_allowlist: [ buyback_pool ], from_ignore: [ treasury_topup ], unit: usd, price_coingecko_id: {{coingecko_id}} }

  # The splitter's buyback share, read daily (the parameter check).
  splitter_burn_share: { type: level, unit: ratio, staleness_days: 7, monitor_only: true, source: { type: contract_read, contract: splitter, function: burn, decimals: 18 } }

  # needs state_delta (Phase 3): flow_usd.stability_fees, Σ ilk Art × Δrate per day from the Vat (incl. allocator ilks)
  # needs state_delta (Phase 3): flow_usd.savings_rate, savings-vault chi growth × supply per day

holder_flows:
  - { id: stakers, kind: fee_share, capture_rule: programmatic, recipient_base: staked, metric: flow_usd.stakers, window_days: 91 }
  - { id: buyback, kind: fee_share, capture_rule: programmatic, recipient_base: staked, metric: flow_usd.buyback, window_days: 91 }

income_statement:
  category: cdp_stablecoin
  scope: protocol_share_only
  window_days: 91
  revenue:
    - { id: surplus_stable, label: "surplus paid to stakers in the stablecoin", metric: flow_usd.stakers, settlement: daily }
    - { id: surplus_buyback, label: "surplus spent buying the token, paid on to stakers", metric: flow_usd.buyback, settlement: daily }
  cost_of_revenue:
    - { id: savers, to: savers, not_measured: "savings rate: needs state_delta on the savings vault (Phase 3)" }
  holders:
    - { id: stakers, of: surplus_stable, bucket: cash, haircut: 0, recipient_base: staked, capture_rule: programmatic }
    - { id: buyback, of: surplus_buyback, bucket: cash, haircut: 0, recipient_base: staked, capture_rule: programmatic }
  checks:
    - { id: splitter_burn, type: parameter, metric: splitter_burn_share, expected: {{splitter_burn_share}}, tolerance_pct: 0 }
    # needs state_delta (Phase 3): { id: surplus_vs_fees, type: two_path, a: flow_usd.stability_fees, b: <surplus less savings>, window_days: 30, tolerance_pct: 5 }
```

## Example values

SKY's contracts from `assets/sky.yaml` (`stable` = USDS, `treasury` = the Pause Proxy, `staking` = lsSKY,
`stakers_farm` = the USDS StakingRewards); the splitter's `burn()` read 0.55 since 2026-08-17.

```yaml example-values
id: sky-t6-example
symbol: SKY
name: Sky (T6 example)
chain: ethereum
token_address: "0x56072C95FAA701256059aa122697B133aDEd9279"
stable_address: "0xdC035D45d973E3EC169d2276DDab16f1e407384F"
splitter_address: "0xBF7111F13386d23cb2Fba5A538107A73f6872bCF"
buyback_pool_address: "0x2621CC0B3F3c079c1Db0E80794AA24976F0b9e3c"
treasury_address: "0xBE8E3e3618f7474F8cB1d074A26afFef007E98FB"
treasury_topup_address: "0xca5183fb9997046fbd9ba8113139bf5a5af122a0"
staking_address: "0xf9A9cfD3229E985B91F99Bc866d42938044FFa1C"
stakers_farm_address: "0x38E4254bD82ED5Ee97CD1C4278FAae748d998865"
chain_id: 1
rpc_url_env: ORION_ETH_RPC_URL
coingecko_id: sky
stable_coingecko_id: usds
emission_note: "not minted; treasury tokens paid beyond the buys are dilution"
splitter_burn_share: 0.55
```

## Scoping checklist

1. Category `cdp_stablecoin`, template T6; surplus paid in the stablecoin, bought tokens, or both.
2. Every line with its rung and contract: the farms, the splitter and buyback route; for Phase 3 the Vat, ilks and
   savings vault.
3. Licence: the RPC's row only.
4. `not_measured` lines and why: the savings rate (and the gross) until `state_delta`.
5. Checks: the splitter share equals the configured one today; plan the Phase 3 gross-vs-surplus check.
6. Supply: total from `totalSupply()` (incl. tokens still in a converter, said in the YAML comment); circulating from
   CoinGecko; treasury payouts beyond buys as `dilution`.
7. Imminent events: splitter share votes, savings-rate changes, token migrations (MKR → SKY).
8. Expected figures re-measured once by hand: 91 days of farm mints and buybacks.
