# JUST (JST)

Researched 2026-09-22. Rank #33 by market cap (layer-1 tokens, stablecoins and tokenized RWAs excluded). Market cap $0.92B, FDV $0.92B, price $0.1128 (CoinGecko, 2026-09-22).
Chain(s): TRON (TRC-20 `TCFLL5dx5ZJdKnWuesXxi1VPwjLVmWZZy9`). CoinGecko id: `just`. DefiLlama slug: `justlend` (parent; child `justlend-v1`), plus the related `usdd`. There is no `just` slug.

## Verdict

Orion fit: B. The quarterly JST buyback-and-burn is real and on-chain: 1.60B JST, about $82M at burn-date prices, over the four rounds from 2025-10 to 2026-07. It is discretionary, run by the JustLend Grants DAO, and it sits on TRON, which is not EVM and needs a TronGrid `http_json`/adapter source. The burns are also far larger than the revenue DefiLlama measures for JustLend. Much of the 2026 pace comes from releasing an accumulated revenue backlog, which ends after 2026, so the recurring run rate is uncertain.

## Business and revenue

- JST is the governance token of JustLend DAO: a Compound-v2-style money market on TRON with an sTRX liquid-staking and Energy Rental market. It also governs the legacy JUST/USDJ system.
- JustLend fees (DefiLlama `justlend`, 2026-09-22): borrower interest plus energy-rental fees of $1.66M over 30d and $12.75M over 1y. Protocol revenue (reserve-factor share only) was $47.8K over 30d and $0.52M over 1y. DefiLlama's methodology states "No revenue distributed to JST holders", and its holders-revenue series shows 0 over 1y. That series is stale relative to the burn program.
- USDD (DefiLlama `usdd`): revenue $0.32M over 30d and $4.23M over 1y. USDD revenue funds JST buybacks only above $10M a year after TRON DAO mining subsidies, a threshold that 1y revenue does not reach.
- There is no equity layer, but JustLend, USDD and SUN sit inside the Justin Sun / TRON DAO ecosystem. "Net revenue" as reported by JustLend (which likely includes energy rental and sTRX income and reserve accumulation since 2024) is an off-chain disclosure that does not reconcile with DefiLlama's revenue figure.

## Holder flows

- id `jst_quarterly_buyback_burn`, kind burn, capture_rule discretionary, recipient_base all
  - Rounds (TronGrid transfers of JST from `TZJVQuU3CJqBScwoxhRtkxQ7JjsNNrpEag` to the black-hole address `T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb`; USD value at the DefiLlama coins price on the burn date):

    | Round | Date | JST | Price | USD |
    |---|---|---|---|---|
    | 1 | 2025-10-19 | 559,890,753 | $0.0321 | $18.0M |
    | 2 | 2026-01-14 | 525,000,000 | $0.0407 | $21.4M |
    | 3 | 2026-04-15 | 271,337,579 | $0.0694 | $18.8M |
    | 4 | 2026-07-17 | 248,357,799 | $0.0975 | $24.2M |

    The docs list rounds 1-3 (page updated 2026-06-10). Round 4 is visible on-chain only.
  - Trailing 12 months: 1,604.6M JST, about $82.4M.
  - Observability: on-chain on TRON via the TronGrid API (`/v1/accounts/T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb/transactions/trc20?contract_address=TCFLL5...&only_to=true`). Filter out the spurious max-uint approval rows. The JustLend docs also carry a Transparency dashboard.
  - Rule: "eligible protocol revenue and JUST ecosystem revenue":
    - 30% of accrued historic JustLend revenue funded round 1, and the remaining 70% is released quarterly through 2026.
    - New quarterly net revenue is used at the start of the next quarter.
    - USDD revenue above $10M a year after subsidies is added.
    - Changes go through governance, but execution and amounts are decided by the Grants DAO. That makes it discretionary.
  - History: announced in October 2025, first burn 2025-10-19, then quarterly. The backlog release ends in Q4 2026. From 2027 only new net revenue (plus any USDD excess) funds burns.

Capture rate today: not meaningful against DefiLlama revenue ($82.4M burned / $0.52M JustLend protocol revenue). Against JustLend gross fees ($12.75M) plus USDD revenue ($4.23M), burns are still about 5x larger, because they are funded by the backlog of accumulated reserves. The underlying recurring capture is unknown until JustLend publishes the revenue base per round. The round sizes of $18-24M a quarter imply that JustLend treats about $70-80M a year as eligible, which does not reconcile.

## Supply

- Initial max supply 9.9B JST. The contract totalSupply() is 9,793,336,268 (a contract-level burn of about 106.7M, date unconfirmed). Program burns of 1,604.6M JST sit at the black-hole address. Total supply = 8,188,743,036 (Tronscan `totalTurnOver`, identical to CoinGecko total and circulating, 2026-09-22).
- supply_basis recommendation: `effective_total` (8.189B), which equals circulating per CoinGecko.
- Emissions: none. Supply is fully issued, so there is no inflation or staking yield. JST locked for governance voting earns nothing.
- Unlocks: none known.
- Round 4 (248M JST) was 3.0% of total supply. Four rounds removed 16.4% of the pre-program supply.

## Data availability for Orion

| metric | source type | endpoint / contract / slug | notes |
|---|---|---|---|
| holder flow (burn), tokens | http_json / adapter | TronGrid `api.trongrid.io/v1/accounts/T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb/transactions/trc20?contract_address=TCFLL5dx5ZJdKnWuesXxi1VPwjLVmWZZy9&only_to=true` | quarterly lumps; value at price on date |
| holder flow USD | derived | tokens x coingecko/defillama historical price | |
| JustLend revenue | defillama | `justlend` dailyRevenue / dailyFees | undercounts the revenue that funds burns |
| USDD revenue | defillama | `usdd` dailyRevenue | $10M threshold |
| supply | http_json / coingecko | Tronscan `apilist.tronscanapi.com/api/token_trc20?contract=TCFLL5...` or `just` | |
| funding base per round | manual | docs.justlend.org/governance/tokenomics | off-chain disclosure |

No EVM RPC can read this flow (TRON). TronGrid is a public JSON API, so an `http_json`-based adapter is feasible.

## Orion mapping

- Modules: holder_cashflow 0.5 (burn), forward_multiple on holder_flow 0.4, forward_multiple on revenue 0.1 (revenue is poorly defined).
- holder_flows: `[{id: jst_quarterly_buyback_burn, kind: burn, capture_rule: discretionary, recipient_base: all, source: adapter trongrid black-hole transfers}]`.
- Assumptions: separate the backlog release (ends 2026-Q4) from recurring revenue. The base case should step the flow down in 2027 to recurring JustLend net revenue, which is unknown; DefiLlama suggests single-digit millions a year. Apply a discretionary haircut, since the program is controlled by a TRON-ecosystem grants DAO.
- Obstacles: there is no published revenue base per round, the DefiLlama holders revenue is 0 (stale), the chain is non-EVM, and there is ecosystem-insider control.

## Sources

- https://docs.justlend.org/governance/tokenomics: buyback program rules, 30%/70% backlog split, USDD $10M threshold, rounds 1-3 amounts (page updated 2026-06-10; accessed 2026-09-22)
- https://api.trongrid.io/v1/accounts/T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb/transactions/trc20?contract_address=TCFLL5dx5ZJdKnWuesXxi1VPwjLVmWZZy9&only_to=true: burn transfers and dates, including round 4 on 2026-07-17 (accessed 2026-09-22)
- https://apilist.tronscanapi.com/api/token_trc20?contract=TCFLL5dx5ZJdKnWuesXxi1VPwjLVmWZZy9: contract totalSupply and total supply (accessed 2026-09-22)
- https://api.llama.fi/summary/fees/justlend?dataType=dailyRevenue (and dailyFees, dailyHoldersRevenue, justlend-v1 methodology): JustLend fees and revenue (accessed 2026-09-22)
- https://api.llama.fi/summary/fees/usdd?dataType=dailyRevenue: USDD revenue (accessed 2026-09-22)
- https://coins.llama.fi/prices/historical/<ts>/coingecko:just: JST prices on burn dates (accessed 2026-09-22)
- https://api.coingecko.com/api/v3/coins/just: market data (accessed 2026-09-22)
