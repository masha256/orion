# SKY (Sky, formerly Maker) onboarding notes, 2026-10-16

Decisions (Mike, 2026-10-16, "Go" on the five recommendations):

1. Holder flow: both halves of the surplus, as cash paid to stakers. USDS minted to the USDS farm, and the SKY the flapper
   buys, which the treasury pays on to staked SKY through the SKY farm. Both `fee_share` (liquid token payouts count as cash).
   This replaced the earlier USDS-only recommendation once the SKY was traced to stakers.
2. Window: 91 days, as for every asset. It holds about a month from before the 2026-08-17 reset, so it reads about 25
   percent low until about 2026-11-16.
3. Recipients: staked SKY (lsSKY, 74 percent of supply), valued per token on total supply (`effective_total`).
4. Treasury SKY paid beyond the buys: report-only dilution, `treasury_net_payout` (357 days: the priced buyback scan cannot backfill past 362 days on keyless CoinGecko).
5. Control: programmatic. The Splitter's share, kick size and hop are executive-vote parameters.

## Mechanism (read on chain 2026-10-16)
- Vow -> Splitter `0xBF71...2bCF`: `burn()` 0.55, `hop()` 2,693 s. Its `File` events: `burn` 1.0 on 2025-11-03 and back to
  0.55 on 2026-08-17; `hop` changed 2026-03-14, 2026-08-17, 2026-09-13, 2026-10-12.
- 45 percent: USDS minted straight into the USDS farm `0x38E4...8865` (StakingRewards, lsSKY staked, 8.6B).
- 55 percent: flapper `0x374D...7407` swaps USDS for SKY on the Uniswap v2 SKY/USDS pair `0x2621...0b9e3c`; the SKY is paid
  out of the pair to the Pause Proxy `0xBE8E...98FB`. 7,020 swaps in the year, 799M SKY for 49.3M USDS.
- The Pause Proxy pays SKY to VestedRewardsDistribution `0x6756...99ee` (dss-vest id 18: 99.5M SKY from 2026-10-12 to
  2027-01-10, about 404M a year), which funds the SKY farm `0xB44C...40Fc` (StakingRewards, lsSKY staked, 8.8B; 581M a
  year at the current rate). A second distribution `0xc8d6...a63f` funds a USDS-staked SKY farm `0x0650...0275` (37.1M
  in the year, nothing in the last 91 days).
- The Pause Proxy sent 1,339M SKY in the year against 799M bought; the gap is a 500M SKY top-up from Safe `0xca51...22a0`
  (2025-11-03). It holds 24.3M SKY.

## Flows (annualized)
- 91 days: stakers 18.0M USD, buyback 26.6M USD, both 44.6M USD (DefiLlama holders revenue 44.2M, reference only).
- Since 2026-08-17 (61 days): stakers 27.0M, buyback 33.2M, both 60.2M.
- By month, buyback USDS: 8.5M (Dec 2025 to Jan 2026), 1.1M (Apr to Jul 2026), 2.8M (Sep 2026).
- FDV 1.65B USD (spot 0.0703, supply 23.45B): 37x the 91-day flow, 27x the post-reset rate.

## Data
- Price: CoinGecko vs DefiLlama coins (cross-check only, 2 percent). The flapper's Chronicle oracle `0xc2ff...cdff` is whitelisted and reverts through Multicall3.
- Total supply: on chain vs CoinGecko, 2 percent. It includes about 2.07B SKY in the MKR converter (fully convertible).
- Staked: `lsSKY.totalSupply()`.
- Code: `flow_annualized` takes `minus: [flows]` for a net rate (the treasury's payout less its buys).

## Open
- Gross revenue (stability fees less the savings rate) is not read on chain; the report's revenue is the surplus that
  reaches holders.
- No surplus-buffer or savings-rate monitoring yet.
