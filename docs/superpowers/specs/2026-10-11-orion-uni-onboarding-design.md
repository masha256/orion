# Orion: UNI onboarding

Date: 2026-10-11. Branch `feat/uni`. Research note: `docs/research/tokens/uni.md` (2026-09-22; its run rate is stale, see 1).

## 1. Mechanism, measured live 2026-10-11

- **Holder flow:** UNIfication (on chain 2025-12-18/19) burns UNI for protocol fees. Each chain's TokenJar releases its fees
  only to whoever burns UNI (Firepit). Every burn ends as a UNI `Transfer` to `0x…dEaD` on Ethereum.
  `totalSupply()` stays 1e9; 0xdead held 112,783,581 UNI (100M of it is the one-off treasury burn, 2025-12-27).
- **Senders over 100 days (6.06M UNI, 2,598 transfers, 36 senders):**
  - 75% from five L2 bridge contracts (OP `L1ChugSplashProxy` and four proxies, all relayed by `0x2cf8…`): fees burned on
    L2s and withdrawn to 0xdead.
  - 25% from about 30 mainnet searcher contracts that burn and take the TokenJar's assets in the same transaction. They rotate
    weekly; many burn once.
- **Rate:** 23.6M UNI/yr over both 30 and 91 days (the token rate is flat); $131.8M/yr at each day's price over 91 days, $185.9M
  over 30 days. The USD gap is the price (from $3.22 on 2026-07-03 to $7.56). DefiLlama reads $122M/yr (it counts fees
  collected, not UNI burned; reference only).
- **Labs growth budget:** `UNIVesting` `0xca046a83edb78f74ae338bb5a291bf6fdac9e1d2` pulls `quarterlyVestingAmount` (5M UNI)
  each calendar quarter from the DAO Timelock `0x1a9C8182C09F50C8318d769245beA52c32BE35BC` to Labs' recipient, limited by the
  Timelock's allowance (20M left on 2026-10-11 = four quarters, through 2027-10). Paid 2026-01-05, 04-10, 07-14, 10-01;
  the recipient forwards it within days. The Timelock holds 262.2M UNI.
- **No staking** and no emission: the UNI minter (2 percent a year) has never been used.
- **Imminent events:** none that move the contracts wired here. The burn-to-staking RFC (2026-06-25) has been quiet since
  2026-07-10. The Arc fee-expansion temp check would add L2 senders, which the any-sender rule picks up.

## 2. Decisions (Mike, 2026-10-11)

1. **Holder flow counts every UNI burn to 0xdead, ignoring the Timelock.** An allowlist would raise `unlisted_sender` every
   week (searchers rotate) and would need code to recognise Firepit transactions to be exact. Risk accepted: a non-fee
   burn from a random wallet counts (1 UNI in 100 days).
2. **Labs vest: dilution in the report only.** The valuation uses effective total supply (1e9 − 0xdead), which already holds
   the Timelock's 262M, so a transfer to Labs moves no supply; an emission would count it twice. Emission = 0. The report
   shows the vest as dilution against the burn (net shareholder yield), read from the vesting contract, capped by the
   allowance left. Not an income-statement cost (Mike, second pick: the quarterly lumps would be noise in a 91-day window).
3. **Supply basis:** effective total (887.2M). Treasury UNI can be spent, and the burn reaches all supply.
4. **Modules:** `holder_cashflow` 0.6 + `forward_multiple` on the holder flow 0.4 (HYPE's shape). Gross swap fees as a
   `monitor_only` display series (DefiLlama `uniswap` dailyFees: the one metric with no on-chain source, allowed by Mike's
   DefiLlama rule).
5. **Window:** 91 days for the run rate and the holder flow, USD at each day's price; backfill 100.

## 3. Metrics

| Metric | Source | Notes |
|---|---|---|
| `price_usd` | coingecko `uniswap` | cross-check: Chainlink UNI/USD `0x553303d460EE0afB37EdFf9bE42922D8FF63220e` `latestAnswer` (8 dp), on chain |
| `effective_supply` | erc20_supply token, subtract [dead] | |
| `circulating_supply` | coingecko | informational |
| `staked_supply` | constant 0 | needs code 4.1 |
| `staker_emission_share` | constant 0 | |
| `emission_rate_annual` | constant 0 (schedule) | minter unused |
| `flow_usd.burn` | transfer_flow UNI → dead, `from_any`, `from_ignore: [timelock]`, usd, `uniswap` | needs code 4.2 |
| `flow_tokens.burn` | same scan, unit tokens, monitor_only | display: UNI burned against UNI vested |
| `revenue_run_rate_usd` | derived flow_annualized(flow_usd.burn, 91) | |
| `labs_vest_rate` | contract_read vesting `quarterlyVestingAmount` × 4, tokens/yr, monitor_only | |
| `labs_vest_approved` | contract_read token `allowance(timelock, vesting)`, monitor_only | the cap on the vest |
| `treasury_uni` | contract_read token `balanceOf(timelock)`, monitor_only | display |
| `flow_usd.swap_fees` | defillama `uniswap` dailyFees, monitor_only | display; reporting `volume` |

Holder flow: `{ id: burn, kind: burn, capture_rule: programmatic, recipient_base: all, metric: flow_usd.burn, window_days: 91 }`.

## 4. Code

1. **Zero from a constant:** `validateReading` lets a `constant` source write 0 on `tokens`/`tokens_per_year` levels (CRV
   spec section 4 foresaw it). Every other source still refuses a non-positive supply.
2. **`transfer_flow.from_any: true`:** counts every sender except `from_ignore`/clones/zero-amount; `from_allowlist` becomes
   optional, exactly one of the two is required, and `count_from` is refused with `from_any`. Scan key and source id use
   `*` for the sender set. Daily `source_detail` keeps per-sender totals by address. Existing assets: unchanged (the field
   is optional with no default; allowlist parsing unchanged), proven by the VVV golden test and every asset's hash pin.
3. **Report dilution:** `reporting.dilution: [{ id, metric, cap_metric? }]` (level metrics in tokens per year; the cap, a
   token level, limits the next year's amount). The report's dilution = (emission + Σ min(rate, cap)) ÷ effective supply.
   Optional, no default: other assets' hashes and reports unchanged.

No engine change, no `ENGINE_VERSION` bump.

## 5. Asset test, persona, checkpoints

- `tests/assets/uni.ingest.test.ts` (AERO/CRV pattern): hash pin, plan batches, a canned fetch with a mainnet fake RPC (a
  bridge sender, a searcher, the Timelock ignored), a valuation `ok` at grade A through `updateAsset`, and the report
  dilution line.
- Persona: `onchain-dex-analyst` (as AERO).
- Cron `orion-uni` 00:40 UTC (17:40 PDT) after `orion-sdcrv`; add to the DST reminder and `docs/ops/hermes-daily-job.md`.
- The five live checkpoints wait for Mike.

## Amendments

- **2026-10-11, build (no value-changing deviation):**
  - `staked_ratio_horizon` bounds are 0.01–1. The engine requires a positive value; with no staking, no emission and no
    fee_share flow, it moves nothing.
  - `flow_tokens.burn` is a monitor_only twin on the same scan (one log scan, two series).
  - Gross swap fees go in `reporting.volume`; the income statement has one line (burn = revenue, payout 100%).
- **2026-10-11, scratch-home live run** (real fetch, throwaway `ORION_HOME`, live DB untouched; about 2 minutes):
  - Every source ok and no anomaly. The Chainlink price cross-check was 0.2% off CoinGecko.
  - Price 7.56. Effective supply 887,216,419. Circulating 624,978,422 (CoinGecko). Treasury 262,247,996.
    Labs vest 20.0M/yr, with 20.0M approved.
  - Burn over the 91 days to 2026-10-10: 5,880,001 UNI, $32.83M. Run rate $131.68M.
  - Gross swap fees $1.708B/yr (DefiLlama).
  - Report: burn yield 1.96%, dilution 2.25% (Labs vest), net shareholder yield −0.29%, multiple 50.9x.
  - Placeholder valuation (flat set, **not a calibration**): status ok, grade A. 12m expected 3.20 against spot 7.56:
    hc 1.36 and fm_holder_flow 5.96 at a 30x multiple. The market pays about 51x the trailing burn.
