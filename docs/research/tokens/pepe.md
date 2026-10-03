# Pepe (PEPE)

Researched 2026-09-22. Rank #16 by market cap (layer-1 tokens, stablecoins and tokenized RWAs excluded). Market cap $2.1B, FDV $2.1B, price $0.00000494 (CoinGecko, 2026-09-22).
Chain(s): Ethereum (ERC-20 `0x6982508145454ce325ddbe47a25d4ec3d2311933`); bridged copies on BNB Chain, Arbitrum, Avalanche. CoinGecko id: `pepe`. DefiLlama slug: none.

## Verdict

Orion fit: D. Pure meme coin: no protocol, no fees, no revenue, no buyback, burn or fee share. Nothing for Orion to value.

- A: revenue-funded holder flow exists, is measurable (on-chain or DefiLlama), and revenue is published. Config-only or near config-only in Orion.
- B: real revenue and a holder flow exist but something is hard: off-chain data, discretionary capture, non-EVM chain needing an adapter, or an equity layer that keeps most value.
- C: revenue exists but nothing reaches holders today (fee switch off, all to validators/treasury), or the flow is inflation-funded; a valuation would rest entirely on an assumed future capture.
- D: no revenue model (store of value, meme, pure inflation staking). Not suitable.

## Business and revenue

None. PEPE describes itself as a community meme token around the Pepe the Frog meme (CoinGecko description, 2026-09-22). No product, no fee-generating contract, no company layer that shares anything with the token. The token contract has no transfer tax (plain ERC-20, launched April 2023; ownership renounced, unconfirmed from memory). No DefiLlama fees/revenue listing (searched the fees overview for "pepe" on 2026-09-22; only unrelated projects "Pepeboost" and "PepeTeam sWAVES" appear).

Annualized revenue: $0.

## Holder flows

none. Tokens sent to `0x...dEaD` by holders (6.92T PEPE, 1.6% of supply, read 2026-09-22) are voluntary one-off burns, not revenue-funded.

Capture rate today: 0 / 0 (no revenue).

## Supply

Total 420,689,899,645,077 PEPE (Ethereum `totalSupply()`, 2026-09-22; max 420.69T per CoinGecko). Balance of `0x000000000000000000000000000000000000dEaD`: 6,917,544,537,128 PEPE (1.64%). CoinGecko reports circulating = total = 420.69T. No emissions, no staking, no vesting or unlocks. supply_basis: `effective_total` (total minus dead balance) if it were ever valued; irrelevant here.

## Data availability for Orion

| metric | source type | endpoint / contract / slug | notes |
|---|---|---|---|
| price, mcap, circ | coingecko | `pepe` | |
| revenue | none | n/a | no revenue exists |
| holder flow | none | n/a | none exists |
| supply | erc20_supply | Ethereum `0x6982508145454ce325ddbe47a25d4ec3d2311933` | fixed supply |

An EVM RPC can read supply and dead-address balances, but there is no flow to read.

## Orion mapping

No modules apply. Not suitable for Orion; any "valuation" would be pure sentiment. If it must appear in a watch list, track price only.

## Sources

- https://api.coingecko.com/api/v3/coins/pepe (supply, contracts, description; 2026-09-22)
- https://api.llama.fi/overview/fees?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true (no PEPE listing; 2026-09-22)
- https://eth.drpc.org eth_call `totalSupply()` and `balanceOf(0x...dEaD)` on the PEPE contract (2026-09-22)
