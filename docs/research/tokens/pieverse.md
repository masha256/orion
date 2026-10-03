# Pieverse (PIEVERSE)

Researched 2026-09-22. Rank #45 by market cap (layer-1 tokens, stablecoins and tokenized RWAs excluded). Market cap $0.49B, FDV $1.79B, price $1.79 (CoinGecko, 2026-09-22).
Chain(s): BNB Chain and Ethereum (same address `0x0e63b9c287e32a05e6b9ab8ee8df88a2760225a9` on both). CoinGecko id: `pieverse`. DefiLlama slug: none.

## Verdict

Orion fit: D. Pieverse is an AI-agent product on BNB Chain: hosted "Purr-Fect Claw" agents with TEE wallets, a Skill Store, and agent-to-agent 402 payment SDKs. It sells subscriptions of $10-279 a month, but it publishes no revenue and documents no link between that revenue and the PIEVERSE token: no buyback, burn or fee share was found. Nothing can be measured or valued.

- A: revenue-funded holder flow exists, is measurable (on-chain or DefiLlama), and revenue is published. Config-only or near config-only in Orion.
- B: real revenue and a holder flow exist but something is hard: off-chain data, discretionary capture, non-EVM chain needing an adapter, or an equity layer that keeps most value.
- C: revenue exists but nothing reaches holders today (fee switch off, all to validators/treasury), or the flow is inflation-funded; a valuation would rest entirely on an assumed future capture.
- D: no revenue model (store of value, meme, pure inflation staking). Not suitable.

## Business and revenue

Pieverse (pieverse.io; CoinGecko categories AI Applications, TimeFi, Binance Alpha Spotlight) lets users provision web3-native AI agents with a TEE-secured wallet ("purr" CLI), install skills from a Skill Store (merchants publish skills), and deploy agents to messaging channels. Pricing page: Starter $10/mo, Basic $29, Standard $49, Pro $99, Ultra $279, with AI credits; crypto-native checkout. Its own docs say live autonomous agent payments (x402, AP2 and similar) are "deferred", not live. Revenue: unknown (no disclosure, no DefiLlama listing). Any revenue accrues to the operating company.

## Holder flows

none found. The site, docs (docs.pieverse.io), pricing page and agent instructions contain no token utility, burn, buyback or staking description. CoinGecko has no description. PIEVERSE tokenomics docs were not located (unknown).

Capture rate today: 0 / unknown.

## Supply

Max/total 1,000,000,000 PIEVERSE; circulating 274,750,000 (27.5%, CoinGecko); FDV/mcap 3.65x. BSC `totalSupply()` = 90,685,594 (read 2026-09-22), so most supply sits on Ethereum or is unminted/bridged elsewhere. First price data Nov 2025 (TGE about Nov 2025, unconfirmed); price rose from about $0.40 (Nov 2025) to $1.79, +86% in the last 30 days. Allocation and unlock schedule: unknown (not found). With 72.5% not circulating, large unlocks are likely. supply_basis: `effective_total` (1B) for a conservative figure.

## Data availability for Orion

| metric | source type | endpoint / contract / slug | notes |
|---|---|---|---|
| price, mcap, circ | coingecko | `pieverse` | |
| revenue | manual | none published | subscriptions off-chain |
| holder flow | none | n/a | |
| supply | erc20_supply | BSC/ETH `0x0e63...25a9` | split across chains |
| unlocks | manual | unknown | |

## Orion mapping

- Not suitable. If the team publishes revenue and a token capture mechanism, revisit with a `forward_multiple` on revenue labeled as company revenue.
- Obstacles: no revenue data, no token claim, unknown unlocks, low float.

## Sources

- https://api.coingecko.com/api/v3/coins/pieverse (supply, contracts, categories; 2026-09-22)
- https://www.pieverse.io/ (product; 2026-09-22)
- https://pieverse.io/pricing.md (subscription tiers; 2026-09-22)
- https://pieverse.io/AGENTS.md and https://pieverse.io/llms.txt (product scope, deferred payment protocols; 2026-09-22)
- https://docs.pieverse.io/llms.txt (docs index, no token section; 2026-09-22)
- https://bsc-dataseed.binance.org eth_call `totalSupply()` (2026-09-22)
- https://coins.llama.fi/chart/coingecko:pieverse (price history; 2026-09-22)
