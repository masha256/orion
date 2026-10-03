# SPX6900 (SPX)

Researched 2026-09-22. Rank #46 by market cap (layer-1 tokens, stablecoins and tokenized RWAs excluded). Market cap $0.49B, FDV $0.49B, price $0.525905 (CoinGecko, 2026-09-22).
Chain(s): Ethereum (ERC-20 `0xe0f63a424a4439cbe457d80e4f4b51ad25b2c56c`, 8 decimals); bridged on Base, Solana, Avalanche. CoinGecko id: `spx6900`. DefiLlama slug: none.

## Verdict

Orion fit: D. Satirical meme coin ("an advanced blockchain cryptography token coin capable of limitless possibilities") with no protocol, fees, revenue, buyback, burn or fee share.

- A: revenue-funded holder flow exists, is measurable (on-chain or DefiLlama), and revenue is published. Config-only or near config-only in Orion.
- B: real revenue and a holder flow exist but something is hard: off-chain data, discretionary capture, non-EVM chain needing an adapter, or an equity layer that keeps most value.
- C: revenue exists but nothing reaches holders today (fee switch off, all to validators/treasury), or the flow is inflation-funded; a valuation would rest entirely on an assumed future capture.
- D: no revenue model (store of value, meme, pure inflation staking). Not suitable.

## Business and revenue

None. The project is a parody of the S&P 500 index; the only described "utility" is the meme itself (CoinGecko description and spx6900.com link, 2026-09-22). No company layer, no fee-bearing contract, no DefiLlama fees listing (searched 2026-09-22).

Annualized revenue: $0.

## Holder flows

none. The 69,012,812 SPX in `0x...dEaD` (6.9% of supply) are a one-off burn, not a recurring or revenue-funded flow (date of burn not researched).

Capture rate today: 0 / 0.

## Supply

Total 1,000,000,000 SPX (Ethereum `totalSupply()`, 2026-09-22). `0x000000000000000000000000000000000000dEaD` holds 69,012,812 SPX, so effective supply is about 930,987,188, which matches CoinGecko's total/circulating 930,987,188 (CoinGecko max 1B). No emissions, staking, vesting or unlocks. supply_basis: `effective_total` if ever needed.

## Data availability for Orion

| metric | source type | endpoint / contract / slug | notes |
|---|---|---|---|
| price, mcap, circ | coingecko | `spx6900` | |
| revenue | none | n/a | none exists |
| holder flow | none | n/a | none exists |
| supply | erc20_supply / contract_read | Ethereum `0xe0f63a424a4439cbe457d80e4f4b51ad25b2c56c`; `balanceOf(0x...dEaD)` | 8 decimals |

An EVM RPC can read supply, but there is no flow.

## Orion mapping

No modules apply. Not suitable for Orion.

## Sources

- https://api.coingecko.com/api/v3/coins/spx6900 (supply, contracts, description; 2026-09-22)
- https://api.llama.fi/overview/fees?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true (no SPX listing; 2026-09-22)
- https://eth.drpc.org eth_call `totalSupply()` and `balanceOf(0x...dEaD)` on the SPX contract (2026-09-22)
