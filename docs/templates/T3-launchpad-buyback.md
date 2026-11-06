# T3 launchpad buyback

**Examples:** PUMP, Zora-like. **Category:** `launchpad`. **Example values:** PUMP (`assets/pump.yaml`, Solana).

A launchpad charges platform fees on its bonding curve and its AMM, pays creators and LPs their shares, and spends part
of its own take buying its token, which is burned (supply drop) or held.

## Lines

| Section | Line | Rung / source | Notes |
|---|---|---|---|
| revenue | `platform_fees` | fee-recipient account inflows — needs `balance_delta` (Phase 3) on Solana; `transfer_flow` into the fee recipient on an EVM chain | **until measured the asset is deferred** (spec §2, D6) |
| cost_of_revenue | `creators`, `lps` | creator-fee and LP-fee accounts | `not_measured` until scanned |
| holders | `buyback` | `contract_state`: the daily fall in the mint's supply (Solana), or a burn-sink scan (EVM) | bucket `burn`; `hold` if bought tokens are kept |
| protocol | remainder | `remainder: protocol` | n/m while revenue is n/m |

## Addresses and endpoints to find

- The mint (Solana) or token (EVM), and whether the mint authority is revoked (then every supply fall is a burn).
- The wallets that buy and burn, and every fee-recipient account (bonding curve, AMM protocol fee, creator vaults).
- A price off the chain's pools (an aggregator price API or a pool read) for the price check. CoinGecko id.
- The unlock schedule of already-minted team/investor tokens (a cited schedule: `dilution`).

## Checks

- `price`: CoinGecko vs a pool-derived price (an `http_json` level here).
- `supply` (Δ supply vs burn instructions) is **refused as circular** on Solana: `solana.supply_burn_daily` is computed
  from `solana.token_supply`'s readings. A real `supply` or `balance` check needs the burn wallets' flows — needs
  `balance_delta` (Phase 3).

## Traps

- A supply drop is a buyback only if nothing else burns: check that the mint authority is revoked and that no other
  program burns (user burns, failed launches).
- Solana has no past-supply read: history starts the day the first reading is stored (backfill only from a cited
  source).
- The burn wallets hold bought tokens between burns: watch their balances (report-only) for a build-up.
- Creator and LP fees are costs of revenue, never revenue the protocol keeps.

## Skeleton

```yaml skeleton
id: {{id}}
symbol: {{symbol}}
name: {{name}}
chain: solana

# No ingest block: Solana is read over JSON-RPC by the solana.* adapters (ORION_SOL_RPC_URL).
contracts:
  token: "{{mint_address}}"             # the mint (mint authority revoked: every supply fall is a burn)
  burn_wallet: "{{burn_wallet_address}}" # buys and burns

external_ids:
  coingecko: {{coingecko_id}}

metrics:
  price_usd:
    type: level
    unit: usd
    staleness_days: 3
    critical: true
    source: { type: coingecko, id: {{coingecko_id}}, field: price }

  # A pool-derived price for the price check (an aggregator's API priced from on-chain pools).
  price_dex_usd:
    type: level
    unit: usd
    staleness_days: 3
    monitor_only: true
    source: { type: http_json, url: "{{dex_price_url}}", path: {{dex_price_path}} }

  total_supply:
    type: level
    unit: tokens
    staleness_days: 7
    critical: true
    source: { type: adapter, name: solana.token_supply, params: { mint: token } }
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
    source: { type: constant, value: 0, note: "no staking; the burn reaches every holder" }

  emission_rate_annual:
    type: schedule
    unit: tokens_per_year
    staleness_days: 45
    critical: true
    source: { type: constant, value: 0, note: "mint authority revoked; unlocks move tokens already in total supply" }

  # The holder flow: the fall in supply per completed UTC day, priced at the day's mean CoinGecko price.
  flow_usd.buyback:
    type: flow
    unit: usd
    cadence: daily
    staleness_days: 4
    critical: true
    source: { type: adapter, name: solana.supply_burn_daily, params: { mint: token, unit: usd, supply_metric: total_supply, days: 7 } }
  flow_tokens.buyback:
    type: flow
    unit: tokens
    cadence: daily
    staleness_days: 4
    monitor_only: true
    source: { type: adapter, name: solana.supply_burn_daily, params: { mint: token, unit: tokens, supply_metric: total_supply, days: 7 } }

  # Report-only: tokens the burn wallet holds (near zero while it burns what it buys).
  burn_wallet_tokens: { type: level, unit: tokens, staleness_days: 7, monitor_only: true, source: { type: adapter, name: solana.owner_balance, params: { mint: token, owner: burn_wallet } }, watch: { change_pct: {{burn_wallet_watch_pct}} } }

  # needs balance_delta (Phase 3): flow_usd.platform_fees, the fee-recipient accounts' daily inflows (Solana)
  # needs balance_delta (Phase 3): flow_usd.creator_fees and flow_usd.lp_fees, the creator-vault and AMM LP fee accounts

holder_flows:
  - { id: buyback, kind: burn, capture_rule: {{capture_rule}}, recipient_base: all, metric: flow_usd.buyback, window_days: 91 }

income_statement:
  category: launchpad
  scope: complete
  window_days: 91
  revenue:
    - { id: platform_fees, label: "platform fees (curve + AMM)", not_measured: "fee-recipient accounts not scanned: needs balance_delta (Phase 3)" }
  cost_of_revenue:
    - { id: creators, to: creators, not_measured: "creator fees: fee accounts not scanned (Phase 3)" }
    - { id: lps, to: lps, not_measured: "AMM LP fees: fee accounts not scanned (Phase 3)" }
  holders:
    - { id: buyback, metric: flow_usd.buyback, bucket: burn, haircut: 0, recipient_base: all, capture_rule: {{capture_rule}}, note: "bought and burned (supply drop)" }
  remainder: protocol
  burned_tokens: [ flow_tokens.buyback ]
  checks:
    - { id: price_dex, type: price, level: price_usd, against: price_dex_usd, tolerance_pct: 2 }
```

## Example values

PUMP's mint, burn wallet and Jupiter price from `assets/pump.yaml`.

```yaml example-values
id: pump-t3-example
symbol: PUMP
name: Pump.fun (T3 example)
mint_address: "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn"
burn_wallet_address: "99mRw3EzdJZWEUjgp1nrU4WeHsukUBjbh7gYE7pm4F3c"
coingecko_id: pump-fun
dex_price_url: "https://lite-api.jup.ag/price/v3?ids=pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn"
dex_price_path: pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn.usdPrice
burn_wallet_watch_pct: 50
capture_rule: discretionary
```

## Scoping checklist

1. Category `launchpad`, template T3; burn or hold.
2. Every line with its rung and account: fee recipients (curve, AMM), creator vaults, burn wallets.
3. Licence: the Solana RPC provider and any price API in `docs/ops/sources-register.md`.
4. `not_measured` lines and why. **Revenue `not_measured` means the asset is deferred** until `balance_delta` ships
   (or an EVM fee recipient can be scanned with `transfer_flow`).
5. Checks: `price`; plan the Phase 3 `balance` check on the burn wallets.
6. Supply: total = mint supply (burns included); circulating from CoinGecko; unlocks as `dilution` with a cited
   schedule.
7. Imminent events: fee-share changes (PUMP's cut from 100 to 50 percent), new products.
8. Expected figures re-measured once by hand: 30 days of supply fall vs the wallets' burn instructions.
