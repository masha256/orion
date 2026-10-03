# ether.fi (ETHFI)

Researched 2026-09-22. Rank #36 by market cap (layer-1 tokens, stablecoins and tokenized RWAs excluded). Market cap $0.68B, FDV $0.68B, price $0.700 (CoinGecko, 2026-09-22).
Chain(s): Ethereum (ERC-20 `0xfe0c30065b384f05761f15d0cc899d4f9f9cc0eb`), plus Base, Arbitrum and Scroll. CoinGecko id: `ether-fi`. DefiLlama slug: `ether-fi` parent does not resolve; use children `ether.fi-stake`, `etherfi-cash-liquid`, `ether.fi-liquid`.

## Verdict

Orion fit: C. ether.fi has about $44M a year of revenue. ETHFI buybacks were real through March 2026 ($9.9M over the trailing year), but DefiLlama shows zero buybacks since April 2026. The programs are Foundation-discretionary (a $50M treasury program below $3, approved Nov 2025). Today, a valuation would rest on buybacks resuming. It moves to B if the buybacks resume or turn out to be running from another address.

## Business and revenue

- Revenue sources:
  - Liquid restaking (eETH/weETH): a protocol share of staking/restaking rewards, withdrawal fees (0.3% fast withdrawal), and validator operations.
  - Liquid vaults: management fees.
  - ether.fi Cash: a card/neobank with transaction fees.
- DefiLlama (2026-09-22):
  - Stake revenue: 30d $1.77M, 1y $32.5M.
  - Cash revenue: 30d $1.73M, 1y $11.5M.
  - Liquid revenue: 30d $0.11M, 1y $1.4M.
  - Total: 30d $3.61M (about $44M annualized); 1y about $45.3M.
- Trend: staking revenue fell from $6.6M a month (Aug 2025) to $1.3-1.6M a month (Jun-Sep 2026). Cash is growing.
- Company layer: ether.fi operates as a company and neobank. DefiLlama marks all revenue as "retained by ether.fi". The ether.fi Foundation holds the DAO treasury.

## Holder flows

- `ethfi_buyback`: kind buy_and_hold (bought ETHFI goes to stakers or to the "Buyback and LP program"; an "on-chain registry records cumulative ETHFI purchased and burned or held"); capture_rule discretionary (Foundation-executed under DAO authorizations); recipient_base all.
  - Trailing annualized: 1y $9.86M; 30d $0; zero every month since April 2026.
  - Source: DefiLlama `ether.fi-stake` dailyHoldersRevenue, computed from Ethereum DEX-aggregator trades by taker `0x2f5301a3D59388c509C65f8698f521377D41Fd0F` plus some off-chain rows for 2024-25.
  - Authorizations:
    - DAO #1/#4 (2024): monthly buyback and LP, up to 25% of revenue.
    - #11 (Apr 2025): withdrawal-queue revenue to buybacks, monthly.
    - Treasury program (2025-10-30): up to $50M, while price is below $3.00. The Foundation may stop it at its discretion.
  - The monthly pattern ($2.2M Aug 2025, $3.2M Nov 2025, $0.4M Mar 2026, then $0) suggests the program paused or moved to a different executor (unknown).
- `ethfi_staker_rebates` (fee_share, staked): DAO #8 (Dec 2024) proposed a 5% protocol-revenue rebate to governance-participating stakers. Its status in 2026 is unknown and DefiLlama does not track it.

Capture rate today: $0 / about $44M (30d). Trailing 1y: $9.86M / $45.3M = 22%.

## Supply

- Max 1.0B. Total 965.35M (CoinGecko; the difference from max suggests about 34.65M burned, unconfirmed). Circulating 965.35M per CoinGecko, which treats everything as circulating; DefiLlama shows about 975M unlocked.
- supply_basis: `circulating`, which equals total here.
- Unlocks (DefiLlama emissions): core contributors at about 1.016M a week until 2027-03-14 (about 25M, 2.6%, over the next 12 months). Investors are fully vested. Other allocations are claim-based.
- Staking: sETHFI. Rewards come from incentives and seasons (emissions and treasury), not a fee share. Staked ratio unknown.

## Data availability for Orion

| metric | source type | endpoint / contract / slug | notes |
|---|---|---|---|
| revenue | defillama | `ether.fi-stake` + `etherfi-cash-liquid` + `ether.fi-liquid` dailyRevenue | sum of children |
| holder flow | defillama / transfer_flow (EVM) | `ether.fi-stake` dailyHoldersRevenue; ETHFI transfers to taker `0x2f5301a3D59388c509C65f8698f521377D41Fd0F` on Ethereum | EVM-readable; currently zero |
| price, supply | coingecko / erc20_supply | `ether-fi`; ETHFI contract | |
| unlocks | http_json | `https://defillama-datasets.llama.fi/emissions/ether.fi` | |

An EVM RPC can read the buyback flow (ETHFI inflows to the executor address).

## Orion mapping

- Modules: forward_multiple on revenue 50%, labeled market convention (company-retained revenue). holder_cashflow 50%, with `ethfi_buyback` (buy_and_hold, discretionary, all) at an assumed capture: bear 0%, base 10-20%, bull 25%.
- Assumptions: revenue growth (Cash growth against a declining staking take), whether buybacks resume, and the $3 price cap of the treasury program.
- Open questions: why buybacks stopped after March 2026; whether bought ETHFI was burned (the supply gap suggests some burns); the rebate program's status.

## Sources

- https://api.llama.fi/summary/fees/ether.fi-stake, /etherfi-cash-liquid, /ether.fi-liquid (all dataTypes, methodology, monthly series) (2026-09-22)
- https://raw.githubusercontent.com/DefiLlama/dimension-adapters/master/fees/ether-fi-stake/index.ts: buyback query, taker address (2026-09-22)
- https://governance.ether.fi/t/3178.json: $50M treasury buyback below $3 (2025-10-30) (2026-09-22)
- https://governance.ether.fi/t/2920.json: #11 withdrawal revenue buyback (2025-04-25) (2026-09-22)
- https://governance.ether.fi/search.json?q=buyback: program history (#1, #4, #8) (2026-09-22)
- https://defillama-datasets.llama.fi/emissions/ether.fi: vesting (2026-09-22)
- https://api.coingecko.com/api/v3/coins/ether-fi and /coins/markets (2026-09-22)
