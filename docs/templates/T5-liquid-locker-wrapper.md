# T5 liquid-locker wrapper

**Examples:** cvxCRV, sdCRV, yCRV (aura, vlAERO lockers). **Category:** `liquid_locker`. **Example values:** yCRV
(`assets/ycrv.yaml`).

A wrapper locks the base token forever in the base protocol's vote escrow, issues a liquid token, and passes the veX
yield to its stakers less a platform fee. Revenue = all veX yield through the wrapper + the platform's fee on boosted
rewards (decision 6). Vote incentives the wrapper sells for its votes are third-party payments: below the line.

## Lines

| Section | Line | Rung / source | Notes |
|---|---|---|---|
| revenue | `fees_rev` | `log_scan`: the veX fees the wrapper's voter sends the splitter | `count_from` the voter on the splitter's one scan |
| holders | `staker_payout` | `log_scan`: the payouts to the staking contract, `apportion`ed by the fee share of the splitter's inflow | bucket `cash`, `valued_per: recipients` when only stakers are paid |
| protocol | `treasury` | `log_scan`: the treasury's share, apportioned the same way | |
| below_line | `incentives_to_holders`, `incentives_to_protocol` | the same two flows, apportioned by the incentive share | third-party vote incentives (rule 3) |
| cost_of_revenue | — | none (decision 6) | LP reward pass-through is `volume`, not revenue (D5) |
| operating_costs | callers, boost delegators | `estimate` of a revenue line, or measured | |

Payouts are measured at the recipients, but the splitter's inflow mixes users' fees and sold incentives. Each payout
flow is read by an **apportion set** (Task 7b): one line per source, `apportion: { by, total }`, carrying the flow ×
(window sum of `by` / window sum of `total`). The `by` series must partition the total, proved by a `sum` check.

## Addresses and endpoints to find

- The wrapper token, its staking contract (`totalSupply()` = staked), the reward token (a vault share: `share_price`).
- The voter proxy, the splitter, the incentive seller (fee burner / auction), the receiver and distributor that pay
  stakers, the treasury.
- Every sender into the splitter (one scan with `count_from` per sender, so all members share one cursor and pricing
  pass).
- CoinGecko ids: the wrapper and the reward's underlying.

## Checks

- `sum` `splitter`: the splitter's gross vs every line of both apportion sets (they read each flow once).
- `sum` `gross_by_sender`: the gross vs the fee and incentive series (one scan: any gap is a data finding).
- `balance`: the distributor's balance vs payouts in − out — needs `balance_delta` (Phase 3) for a reward token with
  no transfer to scan.

## Traps

- Vote incentives are below the line even when the wrapper converts them to the same token as fees.
- The base protocol's gauge emissions passed to LPs are `volume`, not revenue (spec §11 D5).
- A reward paid in vault shares needs `share_price`; a mint into the treasury needs `mint_sender: erc4626_deposit`.
- Treasury reward programs (cvxCRV's CVX) are below the line, to holders, `discretionary`.
- Separate scans per sender drift apart by price revisions alone: use one scan with `count_from`.

## Skeleton

```yaml skeleton
id: {{id}}
symbol: {{symbol}}
name: {{name}}
chain: {{chain}}

contracts:
  token: "{{token_address}}"                 # the wrapper token
  staking: "{{staking_address}}"             # staked wrapper; totalSupply() is the staked amount
  reward_vault: "{{reward_vault_address}}"   # the reward token: vault shares of the fee token
  receiver: "{{receiver_address}}"           # the splitter's staker recipient
  distributor: "{{distributor_address}}"     # pays stakers
  voter: "{{voter_address}}"                 # the wrapper's veX voter: sends the fees
  splitter: "{{splitter_address}}"
  fee_token: "{{fee_token_address}}"
  incentive_seller: "{{incentive_seller_address}}" # sells vote incentives into the fee token for the splitter
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

  # CoinGecko has no circulating figure for most wrappers: the on-chain totalSupply().
  circulating_supply:
    type: level
    unit: tokens
    staleness_days: 14
    source: { type: erc20_supply, token: token }

  staked_supply:
    type: level
    unit: tokens
    staleness_days: 7
    critical: true
    source: { type: contract_read, contract: staking, function: totalSupply, decimals: 18 }

  emission_rate_annual:
    type: schedule
    unit: tokens_per_year
    staleness_days: 7
    critical: true
    source: { type: constant, value: 0, note: "minted 1:1 against the base token locked; no emission schedule" }

  # The holder flow: reward-vault shares into the distributor, converted to the fee token, priced.
  flow_usd.payout:
    type: flow
    unit: usd
    cadence: daily
    staleness_days: 10
    critical: true
    source: { type: transfer_flow, token: reward_vault, to: distributor, from_allowlist: [ receiver ], unit: usd, price_coingecko_id: {{fee_token_coingecko_id}}, share_price: { contract: reward_vault, function: pricePerShare, decimals: 18 } }

  flow_usd.treasury:
    type: flow
    unit: usd
    cadence: daily
    staleness_days: 10
    monitor_only: true
    source: { type: transfer_flow, token: reward_vault, to: treasury, from_allowlist: [ splitter, receiver ], mint_sender: erc4626_deposit, unit: usd, price_coingecko_id: {{fee_token_coingecko_id}}, share_price: { contract: reward_vault, function: pricePerShare, decimals: 18 } }

  # The splitter's inflow, one scan; count_from splits it by sender (same cursor, same pricing pass).
  flow_usd.gross:
    type: flow
    unit: usd
    cadence: daily
    staleness_days: 10
    monitor_only: true
    source: { type: transfer_flow, token: fee_token, to: splitter, from_allowlist: [ voter, incentive_seller ], unit: usd, price_coingecko_id: {{fee_token_coingecko_id}} }
  flow_usd.gross_fees:
    type: flow
    unit: usd
    cadence: daily
    staleness_days: 10
    monitor_only: true
    source: { type: transfer_flow, token: fee_token, to: splitter, from_allowlist: [ voter, incentive_seller ], count_from: [ voter ], unit: usd, price_coingecko_id: {{fee_token_coingecko_id}} }
  flow_usd.gross_incentives:
    type: flow
    unit: usd
    cadence: daily
    staleness_days: 10
    monitor_only: true
    source: { type: transfer_flow, token: fee_token, to: splitter, from_allowlist: [ voter, incentive_seller ], count_from: [ incentive_seller ], unit: usd, price_coingecko_id: {{fee_token_coingecko_id}} }
  # needs balance_delta (Phase 3): distributor_balance_change, for a balance check on the distributor

holder_flows:
  - { id: payout, kind: fee_share, capture_rule: programmatic, recipient_base: staked, valued_per: recipients, metric: flow_usd.payout, window_days: 91 }

income_statement:
  category: liquid_locker
  scope: complete
  window_days: 91
  revenue:
    - { id: fees_rev, label: "veX fees the voter sends the splitter", metric: flow_usd.gross_fees }
  holders:
    - { id: staker_payout, metric: flow_usd.payout, apportion: { by: flow_usd.gross_fees, total: flow_usd.gross }, bucket: cash, haircut: 0, recipient_base: staked, valued_per: recipients, capture_rule: programmatic }
  protocol:
    - { id: treasury, metric: flow_usd.treasury, apportion: { by: flow_usd.gross_fees, total: flow_usd.gross } }
  below_line:
    - { id: incentives_to_holders, to: holders, metric: flow_usd.payout, apportion: { by: flow_usd.gross_incentives, total: flow_usd.gross }, bucket: cash, haircut: 0, recipient_base: staked, valued_per: recipients, capture_rule: programmatic, note: "sold third-party vote incentives" }
    - { id: incentives_to_protocol, to: protocol, metric: flow_usd.treasury, apportion: { by: flow_usd.gross_incentives, total: flow_usd.gross }, note: "sold third-party vote incentives" }
  volume: [ flow_usd.gross ]
  checks:
    - { id: splitter, type: sum, total: [ flow_usd.gross ], parts: [ staker_payout, incentives_to_holders, treasury, incentives_to_protocol ], tolerance_pct: 2 }
    - { id: gross_by_sender, type: sum, total: [ flow_usd.gross ], parts: [ flow_usd.gross_fees, flow_usd.gross_incentives ], tolerance_pct: 0.000001 }
```

## Example values

yCRV's contracts from `assets/ycrv.yaml` (`staking` = YearnBoostedStaker, `reward_vault` = the crvUSD yVault,
`incentive_seller` = Yearn's FeeBurner).

```yaml example-values
id: ycrv-t5-example
symbol: yCRV
name: Yearn CRV (T5 example)
chain: ethereum
token_address: "0xFCc5c47bE19d06BF83eB04298b026F81069ff65b"
staking_address: "0xE9A115b77A1057C918F997c32663FdcE24FB873f"
reward_vault_address: "0xBF319dDC2Edc1Eb6FDf9910E39b37Be221C8805F"
receiver_address: "0x642a16a7885d7a8b9353e2a4b68834f31389dc2c"
distributor_address: "0xb226c52eb411326cdb54824a88abafdaaff16d3d"
voter_address: "0xF147b8125d2ef93FB6965Db97D6746952a133934"
splitter_address: "0x05fc8174050f0a41deb7e562187911d45cd5e401"
fee_token_address: "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E"
incentive_seller_address: "0xb911fcce8d5afcec73e072653107260bb23c1ee8"
treasury_address: "0x044f9c86a0da637a235e83564215dc271bc0defc"
chain_id: 1
rpc_url_env: ORION_ETH_RPC_URL
coingecko_id: yearn-crv
fee_token_coingecko_id: crvusd
```

## Scoping checklist

1. Category `liquid_locker`, template T5; does the wrapper sell vote incentives (apportion sets) or not (plain `of`
   lines, as cvxCRV)?
2. Every line with its rung and contract: voter → splitter → receiver / treasury → distributor; the platform fee route.
3. Licence: the RPC's row only (no API).
4. `not_measured` lines and why (none expected; boost delegators and callers are operating costs).
5. Checks: both `sum` checks measured by hand over 30 days (yCRV: 0.01 percent).
6. Supply: total and circulating = `totalSupply()`; staked from the staking contract; no emissions.
7. Imminent events: base-protocol fee-token changes, wrapper migrations, new staking contracts.
8. Expected figures re-measured once by hand: 91 days of gross by sender, payouts, treasury.
