# GateToken (GT)

Researched 2026-09-22. Rank #27 by market cap (layer-1 tokens, stablecoins and tokenized RWAs excluded). Market cap $1.2B, FDV $1.3B, price $11.07 (CoinGecko, 2026-09-22).
Chain(s): GateChain (native; now branded GateLayer), and Ethereum (ERC-20 `0xe66747a101bff2dba3697199dcce5b743b454759`, where the quarterly burns are executed). CoinGecko id: `gatechain-token`. DefiLlama slug: none for Gate the exchange. `gatelayer` covers only chain fees ($9.9k over one year).

## Verdict

Orion fit: B. Quarterly burns of about $18-34M are fully observable on Ethereum. The link to profit (20% of net profit) is not stated in Gate's burn announcements, and Gate publishes no profit, so the capture rule is discretionary.

## Business and revenue

Gate (Gate.io), a private exchange, earns trading fees and keeps them. It publishes no revenue or profit. The "20% of quarterly net profit" rule comes from the prompt and from older coverage. Gate's Q1 and Q2 2026 burn announcements describe only a "disciplined and transparent burn strategy" and give no formula. The GT page does not state one either.

Implied net profit, if the 20% rule held: Q2 2026 $17.75M / 0.2 = $88.8M a quarter; Q1 2026 $103.4M. Trailing four quarters: about $94M / 0.2 = about $470M a year. The burned token count is stable or rising (2.10M, 2.16M, 2.56M, 2.57M) while the GT price fell by half. That is more consistent with a token-denominated or discretionary schedule than with a fixed share of profit. This is an observation, unconfirmed.

## Holder flows

- id `gt_quarterly_burn`, kind burn, capture_rule discretionary, recipient_base all.
  - On-chain: Transfer from Gate wallet `0x1c4b70a3968436b9a0a9cf5205c787eb81bb558c` to the burn address `0x2b8f8d19f5ba3bec5b44deded3818a427895f308` on Ethereum. The burn address holds 189,947,219.7 GT (2026-09-23), which equals Gate's stated cumulative burn.
  - Quarters:
    - Q3 2025: 2,100,414 GT, on-chain around 2025-10-18. About $33.5M at the October average of $15.97 (own estimate).
    - Q4 2025: 2,163,900 GT, around 2026-01-10. About $22.0M at $10.17 (own estimate).
    - Q1 2026: 2,557,729 GT, "over $20.68M" (Gate, 2026-04-27, tx 0x407753f0…).
    - Q2 2026: 2,570,063 GT, "over $17.75M" (Gate, 2026-07-06, tx 0x2c72fe22…).
  - Trailing annualized: about $94M (four quarters). The latest quarter annualizes to about $71M.
  - History: burns have run since the 2019 mainnet. Cumulative value: over $1.31B (Gate, 2026-07-06).
- Other: GT holders get HODLer airdrops and Launchpool rewards, which are third-party tokens and not Gate revenue. GateChain PoS staking rewards come from an "unmined" pool of 21.25M GT, which is inflation-funded and does not count.

Capture rate today: about $94M burn / Gate net profit (unpublished). It is 20% by the claimed rule, which is unverified.

## Supply

Initial 300M. Burned 189.95M, so the effective supply is about 110.05M. CoinGecko: total 118.89M, circulating 106.64M, max 142.62M. The CoinGecko max and total appear to include the 21.25M unmined staking pool. The Ethereum ERC-20 totalSupply is a fixed 300M, so it is not usable for supply. Emissions: GateChain staking rewards from the unmined pool (rate not found). The burn is about 9.4M GT a year, about 8.5% of supply. supply_basis: effective_total (about 110M), with the unmined pool as a dilution risk.

## Data availability for Orion

| metric | source type | endpoint / contract / slug | notes |
|---|---|---|---|
| price, supply | coingecko | `gatechain-token` | |
| burn (tokens) | contract_read | Ethereum balanceOf(`0x2b8f8d19…f308`) on `0xe66747a1…4759` | EVM; quarterly deltas |
| burn (USD) | derived / manual | delta × price; Gate announcements | |
| profit | manual | none published | |

An EVM RPC can read the burn.

## Orion mapping

- Modules: holder_cashflow 0.5, forward_multiple on holder_flow 0.3, forward_multiple on revenue 0.2 (profit implied from the 20% rule, labeled unverified).
- holder_flows: `gt_quarterly_burn` {burn, discretionary, all, trailing ≈ $94M/yr}.
- Assumptions needed: whether the burn tracks profit or a token schedule; dilution from the unmined pool.
- Obstacles: the rule is not documented in primary sources; no profit disclosure.

## Sources

- https://www.gate.com/announcements/article/100511 (Q2 2026 burn, cumulative figures; 2026-09-22)
- https://www.gate.com/announcements/article/50921 (Q1 2026 burn; 2026-09-22)
- https://www.gate.com/gt (burn records, unmined pool, holder benefits; 2026-09-22)
- https://eth.drpc.org JSON-RPC (burn tx receipts, burn-address balance history; 2026-09-23)
- https://api.coingecko.com/api/v3/coins/markets?ids=gatechain-token and market_chart?days=365 (supply, prices; 2026-09-22)
- https://api.llama.fi/overview/fees (`gatelayer` chain slug; 2026-09-22)
