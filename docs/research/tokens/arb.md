# Arbitrum (ARB)

Researched 2026-09-22. Rank #23 by market cap (layer-1 tokens, stablecoins and tokenized RWAs excluded). Market cap $1.5B, FDV $2.2B, price $0.219859 (CoinGecko, 2026-09-22).
Chain(s): Arbitrum One (ERC-20 `0x912CE59144191C1204E64559FE8253a0e49E6548`), Ethereum (`0xB50721BCf8d664c30412Cfbc6cf7a15145234ad1`), Arbitrum Nova. CoinGecko id: `arbitrum`. DefiLlama slugs: `arbitrum` (chain), `arbitrum-timeboost`, `arbitrum-nitro` (Arbitrum Expansion Program remittances), `arbitrum-nova`.

## Verdict

Orion fit: C. The Arbitrum DAO earns real revenue in ETH: sequencer net fees, Timeboost auctions and AEP remittances. Robinhood Chain's remittances alone run at about $30-40M a year as of September 2026. All of it accrues to the DAO treasury. No buyback, burn or fee-funded staking reached ARB holders as of 2026-09-22. In August 2026 forum threads still describe ARB as "primarily governance".

## Business and revenue

- Sequencer: users pay L2 gas in ETH. Net of L1 posting costs, the surplus goes to the DAO treasury.
  - DefiLlama `arbitrum` revenue: 30d $0.46M, 1y $10.48M.
  - The DefiLlama methodology label "Burned coins" is a generic template; the figure is fees minus L1 costs.
  - Monthly revenue fell from $1.5-3.2M (2025-08 to 2025-10) to about $0.33-0.43M a month in 2026-04 to 2026-09.
- Timeboost (express-lane auction, since 2025-04, `arbitrum-timeboost`): 1y $4.03M, 30d $10.4K. It decayed from $0.85M/month (2025-11) to $38K (2026-08).
- AEP / Arbitrum chains (`arbitrum-nitro`): 10% of net revenue of Robinhood Chain, split 8% to the DAO treasury and 2% to the developer fund. Series starts 2026-05. Revenue: 2026-07 $0.29M, 2026-08 $0.83M, 2026-09 $2.44M in 22 days; 30d $3.12M, or about $38M annualized.
- Total DAO revenue, trailing 30d: about $3.6M, about $43M annualized, dominated by the Robinhood Chain remittance. Over 1y: about $18M.
- Company layer: Offchain Labs (private) builds the stack. The Arbitrum Foundation and DAO own the sequencer surplus. OpCo and other DAO entities spend treasury funds.

## Holder flows

- None.
  - The 2024 "ARB Staking: Unlock ARB Utility and Align Governance" proposal (forum topic 25084) and the 2023 idea of staking for sequencer fees (topic 11764) did not produce a live fee-share. I found no evidence of a fee-funded staking program live in 2026. The status of any staking-reward stream (for example emissions-funded delegate incentives or the Rewarding Active Delegates program, 2025-11) is incentives, not revenue.
  - Buyback proposals appeared in 2025: "Revenue-based buyback" (2025-06-17), "Institutional ARB buyback via bond issuance" (2025-06-24) and "From incentives to inflows" (2025-11-12). None was adopted. Delegates argued for reinvesting instead.
  - The August 2026 thread "Is ARB intended to remain primarily a governance token long term?" confirms: "Today, ARB's primary role is governance."
- The DAO treasury holds ETH (a 6,000 ETH transfer to the Treasury Management portfolio in 2026-03) and ARB. Treasury growth benefits ARB only indirectly (governance claim), so it is not a holder flow.

Capture rate today: 0 / about $43M annualized DAO revenue = 0%.

## Supply

- Total and max 10,000,000,000 ARB. Circulating 6,785,574,605 (CoinGecko, 2026-09-22). No burns.
- The DAO can mint up to 2% a year by constitutional vote. It has not been used (unconfirmed for 2026).
- supply_basis recommendation: `circulating`, because 3.2B is locked team/investor or DAO treasury tokens that unlock or are spent over time. Model the unlock schedule explicitly. Alternatively use effective_total (10B) with no unlock schedule.
- Unlocks (from memory, unconfirmed):
  - Team/advisors (26.94%) and investors (17.53%) vest over four years with a one-year cliff from 2023-03-16, releasing about 92.65M ARB a month until 2027-03. That leaves about 6 months (about 0.56B ARB) in the next 12 months.
  - The DAO treasury (about 3.5B originally) is spent via proposals.
- Emissions: none on a schedule. Staking yield: none fee-funded.

## Data availability for Orion

| metric | source type | endpoint / contract / slug | notes |
|---|---|---|---|
| sequencer revenue | defillama | `arbitrum` dailyRevenue | fees net of L1 cost; to DAO |
| Timeboost | defillama | `arbitrum-timeboost` dailyRevenue | decaying |
| AEP remittances | defillama | `arbitrum-nitro` dailyRevenue | Robinhood Chain; ramping since 2026-07 |
| holder flow | none | none | |
| supply / unlocks | coingecko + manual | `arbitrum`; tokenomist-style schedule | |

An EVM RPC could read treasury inflows on Arbitrum One and Ethereum, but there is no holder flow to read.

## Orion mapping

- Modules: forward_multiple on revenue 1.0, labeled "DAO treasury revenue, market convention". holder_cashflow only in a scenario with an assumed future capture, for example a buyback adopted from 2027 at 10-30% of revenue in the bull case.
- holder_flows: none today.
- Assumptions: revenue base of about $40M a year run rate, driven by AEP. Growth depends on Robinhood Chain and other Arbitrum chains. Timeboost is fading and sequencer revenue is flat. Model the unlock step schedule to 2027-03.
- Obstacles: nothing reaches holders. Governance has repeatedly rejected buybacks, so a valuation would rest on an assumed policy change.

## Sources

- https://api.llama.fi/summary/fees/arbitrum?dataType=dailyRevenue, arbitrum-timeboost, arbitrum-nitro (dailyFees/dailyRevenue/dailyHoldersRevenue): revenue, methodology, monthly series (accessed 2026-09-22)
- https://forum.arbitrum.foundation/t/31215: "Is ARB intended to remain primarily a governance token long term?" (2026-08-16) (accessed 2026-09-22)
- https://forum.arbitrum.foundation/t/30192 and /t/30219: 2025-11 utility and buyback discussions, delegate responses (accessed 2026-09-22)
- https://forum.arbitrum.foundation/search.json?q=buyback: list of buyback proposals 2025 (29462, 29491) and staking topics (25084, 11764) (accessed 2026-09-22)
- https://api.coingecko.com/api/v3/coins/arbitrum: supply and market data (accessed 2026-09-22)
