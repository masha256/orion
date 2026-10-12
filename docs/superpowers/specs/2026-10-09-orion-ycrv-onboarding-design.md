# Orion yCRV onboarding — design

Date: 2026-10-09. Status: built on branch `feat/ycrv`, not merged, nothing on the live home.

## 1. Scope

yCRV (Yearn) is valued as a position **staked in the YearnBoostedStaker (YBS)**: the holder flow is the crvUSD that YBS
stakers are paid. The auto-compounding vault (st-yCRV, legacy) is out of scope. This was the user's choice (2026-10-09):
model the staking that pays crvUSD, the shape the other liquid lockers share (cvxCRV, sdCRV), so they can follow the same
pattern. How the site presents the wrappers against CRV itself is the user's decision, later.

## 2. Cash path (read on chain 2026-10-08/09)

- Fees: Curve FeeDistributor -> CurveYCRVVoter `0xF147…3934` (83.1M veCRV, 10.7 percent of votes) -> YCRVSplitter
  `0x05fc…e401`. 135,673 crvUSD in 91 days (13 weekly payouts), about 0.54M USD a year.
- Vote incentives: Yearn FeeBurner `0xb911…1ee8` sells the vote-market tokens (CJPY, RSUP, CRV, WFRAX, USDC, SDT…) for
  crvUSD -> YCRVSplitter. 392,791 crvUSD in 91 days, about 1.58M USD a year: **about 74 percent of yCRV's cash**.
- YCRVSplitter deposits the crvUSD into the crvUSD-2 yVault `0xBF31…805F` and splits the **shares** by on-chain ratios
  (`getSplits()` 2026-10-09: fees 87.3 percent to YBS, the rest to the treasury, which is the unstaked yCRV's and the
  unmigrated yveCRV's share; incentives 78.0 / 9.3 / 12.7) -> Receiver `0x642a…dc2c`.
- Receiver: 10 percent performance fee (`performanceFee()` = 1000 bps) to the treasury -> SingleTokenRewardDistributor
  `0xb226…6d3d`, which pays YBS stakers weekly. The only sender into the distributor in a year: the Receiver (one stray HEX
  spam transfer aside).
- YBS holds 63.3M of 72.0M yCRV (88.0 percent). The Curve yCRV/CRV pool holds another 7.7M.

## 3. Holder flow

`flow_usd.fees`: `transfer_flow` of yvcrvUSD-2 shares into the distributor, allowlist `[receiver]`. **New:**
`share_price: { contract: yv_crvusd, function: pricePerShare, decimals: 18 }` converts each day's shares to crvUSD at the
vault's share price, read once at the day's last block (only on days with a counted transfer), then priced with CoinGecko
`crvusd`. The share price is written into the row's detail. A read failure fails that day; nothing is written for it.

Run rate: `flow_annualized(flow_usd.fees, 91d)`, as CRV. Live (throwaway home, 2026-10-09): 21 payout days in 100,
**1,520,976 USD a year**. Cross-check against the spike: 329,347 shares × 1.159 × 365/91 ≈ 1.53M. Agrees.

`capture_rule: programmatic` (contract ratios and a settable fee), `recipient_base: staked`.

## 4. Engine change: `valued_per: recipients`

The flow is paid only to staked yCRV; the unstaked share goes to Yearn's treasury. Valued per token of supply, the
model would spread it over 72.0M tokens; the holder who stakes owns it over 63.3M. New optional holder-flow field
`valued_per: recipients` (only with `recipient_base: staked`): the flow is divided by the staked share **now**
(`valuedOverShare` on the driver = staked / effective supply, 0.880 live), in both `holder_cashflow` and
`forward_multiple`. Held at today's share, not the horizon assumption: the splitter sets the stakers' cut from the staked
share (87.3 percent of fees at 88.0 percent staked), so the cash paid grows and shrinks with the staked amount and the
cash per staked token barely moves with it. Refused when nothing is staked. Every existing asset is byte-for-byte
unchanged (the VVV golden test passes; breakdown fields are added only when the share is not 1). No ENGINE_VERSION bump:
no existing output moves.

## 5. Other metrics

- Price: CoinGecko `yearn-crv`, cross-checked against DefiLlama coins (2 percent). Live 0.18345 vs 0.18065 (1.53
  percent, inside the tolerance but close: a thin market).
- `total_supply`: yCRV `totalSupply()` (72.0M). `staked_supply`: YBS `totalSupply()` (63.3M).
- `staker_emission_share` and `emission_rate_annual`: `constant` 0. yCRV is minted 1:1 against locked CRV; no emissions.
- No `vote_incentives` component: yCRV's incentives arrive as crvUSD in the same flow. Their link to CRV emissions (a
  97.2M -> 81.7M CRV a year cut on 2027-08-12, the calendar trigger) belongs in the growth assumptions:
  `terminal_growth` bounds go to -0.2 for that reason.

## 6. Not built (open)

- **Ceiling at CRV's price.** yCRV can be minted 1:1 from CRV, so a target above CRV's is not credible. Orion has no
  cross-asset rule. At 0.18 vs 0.34 the bound is far away; a follow-up, not a blocker.
- **The 10.5M veCRV gap** between the voter's 83.1M veCRV and yCRV + unmigrated yveCRV. It changes the split ratios,
  which the flow already measures; it does not change the per-staked-token value.
- **Calibration**, persona assign, live fetch, first signal, cron line `orion-ycrv`: the CRV checkpoints, after the user
  is back.

## 7. Placeholder check (throwaway home, 2026-10-09; not a calibration)

Flat set: growth -10 percent fading to -5 percent, 17 percent discount, 8× multiple. 12m expected 0.121 against spot 0.183
(hc 0.092, fm 0.166). Consistent with the spike's perpetuity range (0.08–0.13 at 12–20 percent with decaying incentives).
