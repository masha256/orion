# Chainlink (LINK)

Researched 2026-09-22. Rank #3 by market cap (layer-1 tokens, stablecoins and tokenized RWAs excluded). Market cap $9.7B, FDV $12.9B, price $12.94 (CoinGecko, 2026-09-22).
Chain(s): Ethereum (ERC-20 `0x514910771AF9Ca656af840dff83E8264EcF986CA`), bridged to many EVM chains. CoinGecko id: `chainlink`. DefiLlama slug: `chainlink` (parent; children `chainlink-staking`, which actually tracks the Reserve, and `chainlink-requests`).

## Verdict

Orion fit: B. A revenue-funded buy_and_hold flow exists: the Chainlink Reserve buys LINK and holds it. It is measurable on-chain on Ethereum and on DefiLlama (1y $58.5M). But the revenue behind it is only the part Chainlink routes on-chain. Chainlink Labs' total revenue, including enterprise contracts, is private, and how much of it reaches the Reserve is a company decision.

## Business and revenue

- Fees: users of Chainlink services (data feeds, CCIP, Data Streams, SVR, enterprise and bank integrations) pay fees. Many pay in non-LINK tokens or off-chain. Node operators receive most payments. Chainlink Labs, a private company, negotiates enterprise deals and keeps revenue that is not routed on-chain.
- Payment Abstraction: service fees collected on-chain in various tokens land in a fee aggregator (`0xd6e39d42AceE7Abcc460E6Ea78a0844A0980E78f`). They are converted to LINK and sent from the PaymentAbstractionLayer (`0x5680681ED3767B96914CE741a308155C7fB9171d`) to the Reserve (`0x9A709B7B69EA42D5eeb1ceBC48674C69E1569eC6`) (addresses from the DefiLlama adapter `fees/chainlink/index.ts`).
- DefiLlama `chainlink` (2026-09-22): fees (tokens into the fee aggregator) 30d $4.59M, 1y $62.7M. Revenue (LINK into the Reserve) 30d $4.40M, 1y $58.5M, all-time $66.9M. Holders revenue is the same.
- Trend: monthly Reserve inflows have been steady at $4.0-5.8M since 2025-08 (DefiLlama chart), so there is no growth. 30d annualized is $53.5M.
- Company layer: Chainlink Labs keeps enterprise and off-chain revenue at its discretion. The Reserve's stated sources include off-chain enterprise revenue, but the split is not disclosed (unconfirmed). The published "revenue" figure is therefore a floor, not the network's revenue.

## Holder flows

- id `chainlink_reserve`, kind buy_and_hold, capture_rule discretionary, recipient_base all
  - Trailing: $58.5M over 1y, $4.40M over 30d ($53.5M annualized) (DefiLlama holders revenue, 2026-09-22).
  - Observability: the LINK balance of Reserve `0x9A709B7B69EA42D5eeb1ceBC48674C69E1569eC6` was 5,959,393 LINK (about $77.1M at $12.94) via `balanceOf` on Ethereum, 2026-09-22. Inflows can be read with `transfer_flow` (LINK Transfer from PaymentAbstractionLayer to the Reserve).
  - Mechanism: the conversion of on-chain fees to LINK is automated by Payment Abstraction, but which revenue is routed (on-chain vs off-chain) and whether withdrawals happen are Chainlink's decisions. The Reserve was announced in August 2025 and holds LINK. No LINK is burned. Chainlink said it did not plan withdrawals for multiple years (unconfirmed; primary blog URL no longer resolves).
  - History: the DefiLlama adapter starts on 2025-02-21 (the Payment Abstraction flows). The Reserve launched in August 2025 (unconfirmed exact date). Inflows are steady and there have been no announced changes in 2026.
- Staking (v0.2, community and node-operator pools): rewards are paid in LINK from a rewards vault funded from Chainlink's token allocation, not from fee revenue (unconfirmed). Under Orion's rules this is not a holder flow.

Capture rate today: Reserve inflow / published on-chain fees = $58.5M / $62.7M = 93% (1y). Against Chainlink's total revenue it is unknown, because that denominator is not published.

## Supply

- Total and max 1,000,000,000. Circulating 748,099,970 (CoinGecko, 2026-09-22). There are no burns, so effective total = 1B.
- Non-circulating (about 252M) sits in Chainlink-controlled wallets and is released periodically to node-operator rewards, staking rewards and exchange wallets. Historical releases were about 15-20M LINK a quarter (unconfirmed; no formal schedule published).
- supply_basis recommendation: `circulating`, plus an explicit release schedule assumption, or `effective_total` for a conservative case. The Reserve's 5.96M LINK counts as circulating on CoinGecko but is held by the protocol. Consider subtracting it.
- Staking: v0.2 pools hold roughly 45M LINK (unconfirmed). The yield of about 4.3-4.5% is funded by token allocation, which is dilution for non-stakers.

## Data availability for Orion

| metric | source type | endpoint / contract / slug | notes |
|---|---|---|---|
| revenue_run_rate_usd (on-chain floor) | defillama | `chainlink`, dailyFees / dailyRevenue | only on-chain Payment Abstraction flows |
| holder flow (buy_and_hold) | defillama | `chainlink`, dailyHoldersRevenue | same as revenue |
| Reserve inflow (cross-check) | transfer_flow | LINK token, to `0x9A70...9eC6`, from `0x5680...171d` (Ethereum) | EVM-readable |
| Reserve balance | erc20_supply / contract_read | LINK.balanceOf(`0x9A70...9eC6`) | 5.96M LINK on 2026-09-22 |
| supply | coingecko | `chainlink` | release schedule manual |
| total Chainlink revenue | manual | none published | company-private |

An EVM RPC can read the flow: Reserve balance and inflows on Ethereum.

## Orion mapping

- Modules: holder_cashflow 0.5 (buy_and_hold flow; treat it as value only to the extent the held LINK is never re-sold, so haircut it for discretion), forward_multiple on holder_flow 0.3, forward_multiple on revenue 0.2 (on-chain revenue floor, labeled as such).
- holder_flows: `[{id: chainlink_reserve, kind: buy_and_hold, capture_rule: discretionary, recipient_base: all, source: defillama chainlink dailyHoldersRevenue}]`.
- Assumptions: growth of Payment Abstraction revenue (CCIP, SVR, enterprise onboarding), the share of off-chain revenue routed to the Reserve (the key discretionary lever), and a withdrawal risk haircut for the held tokens.
- Open questions: total Chainlink revenue, the Reserve's withdrawal policy in writing, and the LINK release schedule from the non-circulating supply.

## Sources

- https://api.llama.fi/summary/fees/chainlink?dataType=dailyRevenue / dailyHoldersRevenue / dailyFees: totals (accessed 2026-09-22)
- https://api.llama.fi/summary/fees/chainlink-staking?dataType=dailyHoldersRevenue: methodology and monthly chart (accessed 2026-09-22)
- https://raw.githubusercontent.com/DefiLlama/dimension-adapters/master/fees/chainlink/index.ts: fee aggregator, PaymentAbstractionLayer and Reserve addresses (accessed 2026-09-22)
- Ethereum RPC (eth.drpc.org), LINK.balanceOf(0x9A709B7B69EA42D5eeb1ceBC48674C69E1569eC6): 5,959,393 LINK (accessed 2026-09-22)
- https://api.coingecko.com/api/v3/coins/markets?ids=chainlink: supply (accessed 2026-09-22)
- https://blog.chain.link/chainlink-reserve/ now redirects to chain.link/blog. Reserve launch details (Aug 2025, no planned withdrawals for years) are from memory and unconfirmed (accessed 2026-09-22)
