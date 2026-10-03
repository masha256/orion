# AKEDO (AKE)

Researched 2026-09-22. Rank #26 by market cap (layer-1 tokens, stablecoins and tokenized RWAs excluded). Market cap $1.2B, FDV $5.2B, price $0.052015 (CoinGecko, 2026-09-22).
Chain(s): BNB Chain (BEP-20 `0x2c3a8ee94ddd97244a93bc48298f97d2c412f7db`). CoinGecko id: `akedo`. DefiLlama slug: none.

## Verdict

Orion fit: D. AKEDO is an AI "make a game from a prompt" app on BNB Chain whose white paper promises a fee split (33% platform, 33% to AKE stakers, 33% burned). But no revenue is published anywhere, no burn shows on-chain, and the token rose about 130x since June 2026 (from about $0.0004) on a 23% float. There is nothing measurable to value.

- A: revenue-funded holder flow exists, is measurable (on-chain or DefiLlama), and revenue is published. Config-only or near config-only in Orion.
- B: real revenue and a holder flow exist but something is hard: off-chain data, discretionary capture, non-EVM chain needing an adapter, or an equity layer that keeps most value.
- C: revenue exists but nothing reaches holders today (fee switch off, all to validators/treasury), or the flow is inflation-funded; a valuation would rest entirely on an assumed future capture.
- D: no revenue model (store of value, meme, pure inflation staking). Not suitable.

## Business and revenue

AKEDO (akedo.fun, Binance Wallet IDO) is a multi-agent LLM framework that lets creators build small games from natural-language prompts. Games can issue their own bonding-curve "game tokens" paired with AKE. Documented fees: $0.1 per prompt and $10 per publish, payable in AKE; creators also get in-game ad revenue share. Revenue: unknown. No DefiLlama listing, no dashboard, no disclosure found (2026-09-22).

## Holder flows

Documented (white paper "Tokenomics", undated) but unverified:
- `ake_fee_burn`: burn, discretionary (off-chain app fees, no contract enforcing it found), all. 33% of protocol fees. Trailing amount: unknown. The dead address holds 34 AKE, and BSC `totalSupply()` = 100,000,000,000 (read 2026-09-22), so no supply-reducing burn has happened.
- `ake_staker_share`: fee_share, discretionary, staked. 33% of protocol fees "to AKE stakers" (paid in AKE). Trailing amount: unknown; staking contract not identified.

Capture rate today: unknown / unknown. The promised capture is 66% of protocol fees; observed capture is 0.

## Supply

Total/max 100B AKE (BSC `totalSupply` = 100B). Circulating 22.8B (22.8%, CoinGecko); FDV/mcap 4.4x. TGE about August 2025 (first CoinGecko/DefiLlama price 2025-08; exact date unconfirmed). Allocation (white paper): Community 31.5% (node 16%, creator 8%, player 7.5%; 2.08% at TGE then linear 48 months), Investors 25% (3-month cliff, then 24 months linear), Ecosystem & Growth 17.5% (15.8% at TGE; KOL 1.7% over 6 months), Early Contributors 15% (6-month cliff, then 42 months linear), Advisors 5% (6-month cliff, then 42 months), LP 5% (TGE), Airdrop 1% (TGE). Implied monthly unlock now about 1.04B (investors) + 0.48B (contributors + advisors) + 0.64B (community) = about 2.2B AKE/month (about 10% of circulating per month), through about late 2027 (derived; unconfirmed against on-chain vesting). No burns observed. supply_basis: `effective_total` (100B).

## Data availability for Orion

| metric | source type | endpoint / contract / slug | notes |
|---|---|---|---|
| price, mcap, circ | coingecko | `akedo` | |
| revenue | manual | none published | app fees off-chain |
| holder flow (burn) | erc20_supply | BSC `0x2c3a...7db` `totalSupply()` / dead balance | would show burns if they happen; none so far |
| staker share | contract_read | unknown staking contract | not found |
| unlocks | manual | white paper | |

## Orion mapping

- Not suitable today. If the project publishes revenue and burns start, a `holder_cashflow` on burn + staker fee_share (recipient_base staked) with a `forward_multiple` on revenue could be configured on BSC.
- Obstacles: no revenue data; burn and staker share unobserved; extreme price run-up; heavy ongoing unlocks.

## Sources

- https://api.coingecko.com/api/v3/coins/akedo (supply, description, categories; 2026-09-22)
- https://akedo-1.gitbook.io/akedo-whitepaper/tokenomics.md (allocation, vesting, fee split; 2026-09-22)
- https://akedo-1.gitbook.io/akedo-whitepaper/explore-akedo/monetization.md (revenue streams; 2026-09-22)
- https://api.llama.fi/overview/fees (no AKEDO listing; 2026-09-22)
- https://bsc-dataseed.binance.org eth_call `totalSupply()` and dead-address balance (2026-09-22)
- https://coins.llama.fi/chart/coingecko:akedo (price history, $0.0003-0.0004 Nov 2025-Jun 2026; 2026-09-22)
