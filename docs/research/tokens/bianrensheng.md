# 币安人生 / "Binance Life" (币安人生)

Researched 2026-09-22. Rank #43 by market cap (layer-1 tokens, stablecoins and tokenized RWAs excluded). Market cap $0.51B, FDV $0.51B, price $0.512556 (CoinGecko, 2026-09-22).
Chain(s): BNB Chain (BEP-20 `0x924fa68a0fc644485b8df8abfa0a41c2e7744444`). CoinGecko id: `bianrensheng`. DefiLlama slug: none (the launchpad it came from is `four.meme`).

## Verdict

Orion fit: D. A Chinese-language BNB Chain meme coin ("币安人生" = "Binance Life") launched on the four.meme launchpad; fixed supply, owner renounced, no fees, revenue, buyback, burn or fee share.

- A: revenue-funded holder flow exists, is measurable (on-chain or DefiLlama), and revenue is published. Config-only or near config-only in Orion.
- B: real revenue and a holder flow exist but something is hard: off-chain data, discretionary capture, non-EVM chain needing an adapter, or an equity layer that keeps most value.
- C: revenue exists but nothing reaches holders today (fee switch off, all to validators/treasury), or the flow is inflation-funded; a valuation would rest entirely on an assumed future capture.
- D: no revenue model (store of value, meme, pure inflation staking). Not suitable.

## Business and revenue

Identity: CoinGecko names it "币安人生 (BinanceLife)", symbol 币安人生, BNB Chain only, no homepage and no description (2026-09-22). The contract address ends in `...4444`, the vanity suffix used by four.meme launchpad deployments; it is one of the Chinese-named memes that rallied on BNB Chain in October 2025 around Binance/CZ social posts (origin story from memory, unconfirmed). It is not an official Binance token.

No product and no revenue. The only fee-earning party is the launchpad (four.meme: DefiLlama revenue 1y $82.3M, 30d $0.22M, 2026-09-22), which does not share anything with this token's holders. `owner()` returns the zero address (renounced; read 2026-09-22). Bytecode is about 3.8 KB, consistent with a plain ERC-20 without a tax module (not source-verified here; unconfirmed).

Annualized revenue: $0.

## Holder flows

none. 433,078 tokens (0.04%) sit in `0x...dEaD` from voluntary sends.

Capture rate today: 0 / 0.

## Supply

Total 1,000,000,000 (BSC `totalSupply()`, 2026-09-22); CoinGecko circulating = total = max = 1B. No emissions, staking, vesting or unlocks. supply_basis: `circulating` (= total).

## Data availability for Orion

| metric | source type | endpoint / contract / slug | notes |
|---|---|---|---|
| price, mcap, circ | coingecko | `bianrensheng` | non-ASCII symbol; use the id |
| revenue | none | n/a | none exists |
| holder flow | none | n/a | none exists |
| supply | erc20_supply | BSC `0x924fa68a0fc644485b8df8abfa0a41c2e7744444` | fixed 1B |

An EVM RPC (BNB Chain) can read supply; no flow exists.

## Orion mapping

No modules apply. Not suitable for Orion. Note for tooling: the symbol is Chinese characters, so file names, config keys and CLI output should use the CoinGecko id `bianrensheng`.

## Sources

- https://api.coingecko.com/api/v3/coins/bianrensheng (name, supply, contract; 2026-09-22)
- https://bsc-dataseed.binance.org eth_call `totalSupply()`, `owner()`, `balanceOf(0x...dEaD)`, `eth_getCode` (2026-09-22)
- https://api.llama.fi/summary/fees/four.meme?dataType=dailyRevenue (launchpad revenue, for context; 2026-09-22)
