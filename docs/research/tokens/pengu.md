# Pudgy Penguins (PENGU)

Researched 2026-09-22. Rank #39 by market cap (layer-1 tokens, stablecoins and tokenized RWAs excluded). Market cap $0.63B, FDV $0.77B, price $0.01000104 (CoinGecko, 2026-09-22).
Chain(s): Solana (SPL `2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv`, native); bridged on Ethereum and BNB Chain (`0x6418c0dd099a9fda397c766304cdd918233e8847`), Abstract, HyperEVM, Robinhood chain. CoinGecko id: `pudgy-penguins`. DefiLlama slug: none.

## Verdict

Orion fit: D. PENGU is the brand/community coin of the Pudgy Penguins NFT franchise. The operating company (Igloo Inc.) earns revenue from toys, licensing, games and the Abstract chain, but none of it reaches PENGU: no buyback, burn, fee share or staking claim was found. Company revenue is private and unpublished, so even a market-convention revenue multiple has no data.

- A: revenue-funded holder flow exists, is measurable (on-chain or DefiLlama), and revenue is published. Config-only or near config-only in Orion.
- B: real revenue and a holder flow exist but something is hard: off-chain data, discretionary capture, non-EVM chain needing an adapter, or an equity layer that keeps most value.
- C: revenue exists but nothing reaches holders today (fee switch off, all to validators/treasury), or the flow is inflation-funded; a valuation would rest entirely on an assumed future capture.
- D: no revenue model (store of value, meme, pure inflation staking). Not suitable.

## Business and revenue

Igloo Inc. (Luca Netz, CEO) owns Pudgy Penguins IP and sells physical toys at retailers (Walmart, Target), licenses the IP, runs games (Pudgy Party), and incubated the Abstract L2. Reported retail toy sales of more than $10M and over 1M units by early 2025 (from memory, unconfirmed; no primary filing found). Igloo is a private company; revenue stays in the company (equity layer keeps 100%). CoinGecko describes PENGU as "the world's social currency" with no economic rights (2026-09-22). No DefiLlama fees listing for Pudgy, PENGU or Igloo (searched 2026-09-22).

Annualized revenue attributable to the token: $0. Company revenue: unknown (private).

## Holder flows

none. No buyback, burn, fee share or revenue-funded staking reward found (CoinGecko description; pengu.pudgypenguins.com and pudgypenguins.com returned HTTP 403 to automated fetches on 2026-09-22, so the official tokenomics page could not be re-read).

Capture rate today: 0 / unknown company revenue = 0%.

## Supply

Max 88,888,888,888 PENGU; CoinGecko total 76,722,814,816 and circulating 62,860,396,090 (70.7% of max) on 2026-09-22. Allocation (tokenomist, 2026-09-22): Pudgy community 25.90%, other communities 24.12%, current and future team 17.80%, liquidity 12.35%, company 11.48%, proliferation 4%, public good 4%, FTT holders 0.35%. Team and company tranches (29.28%) vest after a one-year cliff from the December 2024 TGE with linear vesting to about December 2028 (schedule from memory and tokenomist's "extends into 2028"; tokenomist's page also claims "fully unlocked", which conflicts with its own 29.28% locked figure; treat the schedule as unconfirmed). The gap between max and CoinGecko total (about 12.2B) is plausibly unclaimed airdrop tokens removed from supply (unconfirmed). No emissions, no staking yield. supply_basis: `effective_total` (CoinGecko total) given ongoing team/company unlocks of roughly 7-8B PENGU per year (derived, unconfirmed).

## Data availability for Orion

| metric | source type | endpoint / contract / slug | notes |
|---|---|---|---|
| price, mcap, circ | coingecko | `pudgy-penguins` | |
| revenue | manual | none published | Igloo Inc. is private |
| holder flow | none | n/a | none exists |
| supply | coingecko / adapter | Solana SPL mint `2zMMhc...uv` | native on Solana; EVM copies are bridged, not the canonical supply |
| unlocks | manual | tokenomist / official docs | conflicting sources |

No EVM RPC can read a flow (none exists; canonical token is on Solana).

## Orion mapping

No modules apply. A `forward_multiple` on Igloo revenue would need a published company revenue figure and would value the equity, not the token (methodological position 2). Not suitable.

## Sources

- https://api.coingecko.com/api/v3/coins/pudgy-penguins (supply, contracts, description; 2026-09-22)
- https://tokenomist.ai/pudgy-penguins (allocation, unlocked share; 2026-09-22)
- https://en.wikipedia.org/wiki/Pudgy_Penguins (company background only; 2026-09-22)
- https://pengu.pudgypenguins.com/ and https://www.pudgypenguins.com/ (HTTP 403, not readable; 2026-09-22)
- https://api.llama.fi/overview/fees?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true (no listing; 2026-09-22)
