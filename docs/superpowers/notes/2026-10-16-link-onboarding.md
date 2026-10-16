# LINK (Chainlink) onboarding notes, 2026-10-16

Decisions (Mike, 2026-10-16, "go" on the scoping recommendations):

1. Holder flow: the Chainlink Reserve's buys, `buy_and_hold`, `capture_rule: discretionary`. Chainlink chooses which revenue
   is routed on chain and controls the Reserve's timelock, so the flow is valued with the discretionary premium and never
   shrinks the supply path (held, not burned).
2. Supply basis: `effective_total` (total supply, 1B), as for every Orion asset. Circulating (CoinGecko, 767M) is the
   report's market cap only.
3. The Reserve's 6.29M LINK is not netted from supply: 0.6 percent of supply, and netting it would treat the hold as a burn.
4. The releases from Chainlink's non-circulating Safes are report-only dilution (`reporting.dilution`), measured on chain.
5. The hold bucket's overhang haircut: 5 percent (`reporting.haircuts.reserve`). LINK is the first asset in that bucket.

## Mechanism (read on chain 2026-10-16)
- Payment Abstraction `0x5680…171d` converts service fees paid on chain into LINK and sends them to the Reserve
  `0x9A70…9eC6` (RBACTimelock) every Thursday since 2025-08-07; last payment 2026-10-15.
- The Reserve holds 6,293,843 LINK. Its only outflow is a 1-LINK test on 2025-08-02. About 30 test sends from other wallets
  (21 LINK in all, August 2025) are under the 10-LINK dust floor; any larger send from another wallet raises an alert.
- Monthly buys in LINK: 707k (July 2026), 463k (August), 374k (September). The dollar flow is steadier because the price rose.

## Releases (dilution)
- Nine Chainlink Safes hold 240.5M LINK (seven untouched since June 2022). Releases come from other Chainlink Safes each
  quarter (2025-12-19, 2026-04-03, 2026-06-19, 2026-10-09) into two wallets:
  - `0x9b1c…cde9` (EOA): forwards each release to an exchange wallet `0x28c6…1d60` within hours. 253.8M LINK since 2022-08;
    58.9M in the year to 2026-10-16.
  - `0xD50f…78Af` (Safe): funded each quarter (11.1M in the year), drips about 0.5M LINK a week to `0x7a28…14a3`.
- 70.0M LINK in the year, matching CoinGecko's circulating supply rising from 696M to 767M. About 14 times the LINK the
  Reserve buys (about 4.9M a year).
- `released_rate` = both wallets' inflows over the last 365 days (any sender, dust under 1,000 LINK ignored). The source
  Safes rotate, so the scan is on the receiving wallets; if Chainlink changes the release route the rate falls to zero, which
  the analyst should notice against CoinGecko's circulating figure.

## Data checks
- Price: CoinGecko vs the Chainlink LINK / USD feed `0x2c1d…127c` (2 percent).
- Total supply: on chain 1B vs CoinGecko 1B (2 percent). Nothing burned (dead holds about 110 LINK of stray sends).
- No DefiLlama source. Reference only: our 91-day flow is 57.7M USD a year against DefiLlama's 62.4M; the gap is DefiLlama
  listing the 2026-10-15 payment twice (on 10-15 and the partial 10-16). Without it, 57.9M (0.3 percent apart). By month:
  July +0.10, August -0.61, September -1.38 percent (price timing).

## Open
- Enterprise and off-chain revenue is private; the Reserve's buys are a floor on what reaches holders.
- No written withdrawal policy for the Reserve.
- Staking v0.2 (40.9M LINK in the community pool) is paid from Chainlink's allocation, so it is part of the releases.
