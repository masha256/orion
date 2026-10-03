# Aave (AAVE)

Researched 2026-09-22. Rank #11 by market cap (layer-1 tokens, stablecoins and tokenized RWAs excluded). Market cap $2.2B, FDV $2.3B, price $144.95 (CoinGecko, 2026-09-22).
Chain(s): Ethereum (ERC-20 `0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9`). The protocol is deployed on many EVM chains. CoinGecko id: `aave`. DefiLlama slug: `aave` (parent; `aave-v3`, `aave-v4`, `aave-v2`).

## Verdict

Orion fit: C (today). The Aave DAO has large, published revenue ($97.5M over 1y on DefiLlama). But its only holder flow, the discretionary AAVE buyback, has been paused since 2026-04-19 after the rsETH incident. Trailing 30d holders revenue is $0. If the buyback resumes, it becomes B (a discretionary buy_and_hold, measurable on DefiLlama).

## Business and revenue

- Fees: borrowers pay interest, plus flash-loan and liquidation fees, GHO interest and Chainlink SVR recapture. Most goes to suppliers. The reserve factor goes to the Aave DAO Collector (treasury, `0x464C71f6c2F760DdA6093dCB91C24c39e5d6e18c`).
- DefiLlama `aave` (2026-09-22): fees 30d $36.2M, 1y $752.2M. Revenue (treasury) 30d $5.13M, 1y $97.5M. Holders revenue 30d $0, 1y $21.0M, all-time $42.9M.
- Trend: DAO revenue is falling. The TokenLogic ARFC (2026-03-04) cites January 2026 revenue of $7.95M vs $13.5M in January 2025, 2025 annual revenue of $142M (the DAO's own figure, broader than DefiLlama's), and an optimistic 2026 opex budget of $190M, a structural deficit. The 30d DefiLlama figure ($5.1M, about $62M annualized) is well below the 1y figure.
- Company layer: Aave Labs, a private company, has historically kept front-end and product revenue. The "Aave Will Win" temp check (2026-02-12, still active 2026-09-20) proposes directing 100% of Aave-branded product revenue to the DAO in exchange for a development budget. It had not been implemented as of the research date (unconfirmed final status).

## Holder flows

- id `aave_buyback`, kind buy_and_hold, capture_rule discretionary, recipient_base all
  - Trailing: 30d $0. 1y $21.0M (DefiLlama holders revenue, all before 2026-04-19). Monthly: about $3.8M/month in Aug-Nov 2025, $2.7-2.8M in Dec 2025-Jan 2026, $0.41M in Feb 2026, $6.16M in Mar 2026, then about $0 (small amounts in May-June are likely settlement), $0 in Jul-Sep 2026.
  - Rule and control: the Aavenomics buyback started 2025-04-09 at about $1M/week. The ACI ARFC (2025-10-22) made it a $50M/yr program with a $250K-$1.75M weekly range, led by TokenLogic with the Aave Finance Committee (AFC), and the AFC has discretion within ±75%. On 2026-03-04 the budget was cut to about $30M/yr, funded mainly with ETH/volatile assets through the MainnetSwapSteward. It has been paused since 2026-04-19 after the Kelp rsETH/LayerZero bridge exploit, and the DAO donated 25,000 ETH to restore the rsETH backing. The ARFC of 2026-04-22 formalized the pause, with "cadence will be revisited at a later date". A community thread "Restart aave buy backs" (2026-05-18) has not produced a restart.
  - Destination: bought AAVE is held by the DAO. It is not burned and not paid to stakers. It went to treasury wallets (the Ecosystem Reserve `0x25F2226B597E8F9514B3F68F00f494cF4f286491` held 571,075 AAVE on 2026-09-22, and the Collector held 0 AAVE plus 6,590 aAAVE). The Ecosystem Reserve funds stkAAVE emissions, so part of the bought AAVE is recycled into staker rewards (link unconfirmed).
  - Total acquired: over 205,000 AAVE (1.28% of supply) from April 2025 to March 2026 (ARFC 2026-03-04).
- Staking (stkAAVE / Umbrella): stkAAVE rewards are AAVE emissions from the Ecosystem Reserve, targeting a 2.75% APR. The rate was cut from 220 to 150 AAVE/day, about 54,750 AAVE/yr (about $7.9M), by ARFC 2026-05-20. That is token-funded, not a revenue share, so it is not a holder flow. Umbrella (2025) stakes aTokens to cover bad debt, and its rewards go to aToken stakers, not AAVE holders.
- Proposals: a temp check "Aave Protocol Treasury Revenue Sharing Program" (2026-04-07) would pay 0.25% of monthly revenue to stakers of 30+ days. It is only a temp check, not adopted.

Capture rate today: $0 / $62M annualized revenue (30d) = 0%. Over 1y it was $21.0M / $97.5M = 22%. At the $30M budget it would be about 30-50% of revenue.

## Supply

- Total and max 16,000,000. Circulating 15,428,925 (CoinGecko, 2026-09-22). No burns. The Ecosystem Reserve (571K) is the main non-circulating pool.
- Emissions: stkAAVE rewards of 150 AAVE/day (about 0.34% of supply a year), paid from existing reserve tokens, not newly minted. They still dilute non-stakers from a circulating-supply view. stkAAVE totalSupply is 2,488,570 (about 15.6% of supply staked, 2026-09-22 RPC).
- supply_basis recommendation: `circulating` (15.43M). The treasury's AAVE (including buybacks) is held and not burned.
- Unlocks: none scheduled. Treasury spending (grants, the possible Aave Labs budget under "Aave Will Win") is the release risk.

## Data availability for Orion

| metric | source type | endpoint / contract / slug | notes |
|---|---|---|---|
| revenue_run_rate_usd | defillama | `aave`, dailyRevenue | DAO figure ($142M for 2025) is broader |
| holder flow (buyback) | defillama | `aave`, dailyHoldersRevenue | 0 since 2026-04-19 |
| buyback in tokens (cross-check) | transfer_flow | AAVE transfers into Ecosystem Reserve/Collector from the swap steward | addresses to confirm |
| staking | contract_read | stkAAVE `0x4da27a545c0c5B758a6BA100e3a049001de870f5` totalSupply | |
| supply | coingecko / erc20_supply | `aave` | |
| buyback status and budget | manual | governance.aave.com funding updates | discretionary |

An EVM RPC can read the flow when it exists, as AAVE inflows to DAO wallets on Ethereum.

## Orion mapping

- Modules: forward_multiple on revenue 0.6 (labeled market convention: DAO revenue with no binding claim), holder_cashflow 0.4 on an assumed resumed buyback. Scenarios: bear, 0 for years. Base, a restart in 2027 at about $30M/yr. Bull, $50M/yr plus a revenue share.
- holder_flows: `[{id: aave_buyback, kind: buy_and_hold, capture_rule: discretionary, recipient_base: all, source: defillama aave dailyHoldersRevenue, current: 0}]`.
- Obstacles: the flow is discretionary and paused. The DAO faces an operating deficit, and bought tokens are partly recycled into staking emissions. The "Aave Will Win" outcome changes the revenue base.

## Sources

- https://api.llama.fi/summary/fees/aave?dataType=dailyRevenue / dailyHoldersRevenue / dailyFees (accessed 2026-09-22)
- https://api.llama.fi/summary/fees/aave-v3?dataType=dailyHoldersRevenue: methodology ("buy back ... after 9th April 2025") and monthly series (accessed 2026-09-22)
- https://governance.aave.com/t/24686: [ARFC] Pause AAVE Buybacks, 2026-04-22 (accessed 2026-09-22)
- https://governance.aave.com/t/24229: [ARFC] Buyback Program - Budget Adjustment, 2026-03-04 ($50M to $30M, 205k AAVE acquired, revenue figures) (accessed 2026-09-22)
- https://governance.aave.com/t/23290: [ARFC] AAVE Buybacks program: An update, 2025-10-22 ($50M/yr, AFC discretion) (accessed 2026-09-22)
- https://governance.aave.com/t/24945: [ARFC] stkAAVE Emissions Update, 2026-05-20 (150 AAVE/day, 25,000 ETH rsETH donation) (accessed 2026-09-22)
- https://governance.aave.com/t/24055: [TEMP CHECK] Aave Will Win Framework, 2026-02-12 (accessed 2026-09-22)
- https://governance.aave.com/t/24395: [TEMP CHECK] Treasury Revenue Sharing Program, 2026-04-07 (accessed 2026-09-22)
- https://governance.aave.com/t/24936: Restart aave buy backs, 2026-05-18 (accessed 2026-09-22)
- Ethereum RPC (eth.drpc.org): AAVE balances of the Collector and Ecosystem Reserve, stkAAVE totalSupply (accessed 2026-09-22)
- https://api.coingecko.com/api/v3/coins/aave: supply (accessed 2026-09-22)
