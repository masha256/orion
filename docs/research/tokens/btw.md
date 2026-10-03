# Bitway (BTW)

Researched 2026-09-22. Rank #10 by market cap (layer-1 tokens, stablecoins and tokenized RWAs excluded). Market cap $2.5B, FDV $9.1B, price $0.9153 (CoinGecko, 2026-09-22).
Chain(s): BNB Chain (BEP-20 `0x444045b0ee1ee319a660a5e3d604ca0ffa35acaa`), Ethereum (ERC-20 `0x3a63de3572c69a1307ff08394f3ee7702c16d25d`); planned native gas token of the Bitway Ledger PoS appchain. CoinGecko id: `bitway`. DefiLlama slug: `bitway-earn`.

## Verdict

Orion fit: C. Bitway Earn has small, published revenue (about $0.6M over its six months, about $1.5M annualized recently), but no fee share, buyback or burn reaches BTW; the token offers access, fee discounts, governance and future appchain staking. The $2.5B market cap is about 65x its May 2026 price. That, a 27% float and large 2027 cliffs make it a low-float speculative listing.

- A: revenue-funded holder flow exists, is measurable (on-chain or DefiLlama), and revenue is published. Config-only or near config-only in Orion.
- B: real revenue and a holder flow exist but something is hard: off-chain data, discretionary capture, non-EVM chain needing an adapter, or an equity layer that keeps most value.
- C: revenue exists but nothing reaches holders today (fee switch off, all to validators/treasury), or the flow is inflation-funded; a valuation would rest entirely on an assumed future capture.
- D: no revenue model (store of value, meme, pure inflation staking). Not suitable.

## Business and revenue

Bitway (built by Side Labs) calls itself an "internet capital gateway": Bitway Earn (stablecoin/BTC yield vaults running basis and TradFi-style strategies, integrated in Binance Wallet), a Bitcoin-compatible dPoS appchain "Bitway Ledger", the BTCT FROST-based bitcoin bridge, and native BTC lending. White paper revenue model: management and performance fees on Earn AUM, a share of lending interest, liquidation fees, and appchain network/payment fees. The protocol (Side Labs) keeps the revenue; there is no stated token claim on it.

DefiLlama `bitway-earn` (2026-09-22): fees (gross vault yield + flash-unstake penalties) 30d $564,903, 1y $2,870,176; revenue (protocol keeps, after depositor yield) 30d $121,668, 1y (since listing, March 2026) $586,034, i.e. about $1.48M annualized on 30d. Monthly revenue: Jan 2026 $27k, Mar $34k, May $75k, Jun $95k, Jul $96k, Aug $118k, Sep 1-22 $83k. Holders revenue: 0.

## Holder flows

none. The white paper and docs list staking for "exclusive access", "boosted rewards and fee benefits", governance and appchain validator/delegator staking; appchain staking rewards would be emissions/gas, not revenue share. No buyback or burn program found.

Capture rate today: 0 / $586,034 (1y revenue) = 0%.

## Supply

Total and max 10,000,000,000 BTW (BSC `totalSupply()` = 10.0B, read 2026-09-22). Circulating 2.708B (27.1%, CoinGecko); FDV/mcap 3.7x. TGE Q1 2026 (DefiLlama listing 2026-03-12; white paper roadmap). Allocation (white paper): Community 26.67% (2% at TGE, rest linear 41 months), Ecosystem 20% (3% at TGE, linear 41 months; managed by Side Labs), Team 20% (12-month lockup, then 36 months linear), Backers 16.33% (12-month lockup, then 24 months linear), Partners 12% (fully unlocked at TGE), Liquidity 5% (unlocked at TGE). Implied unlocks: about 110M BTW/month now (community + ecosystem), rising to about 235M/month from about March 2027 when team (about 56M/month) and backers (about 68M/month) cliffs end; roughly 1.3B BTW over the next 6 months and 2.8B over 12 months (derived from the white paper; exact TGE day unconfirmed). No burns. supply_basis: `circulating` is misleading given the schedule; use `effective_total` (10B) for a conservative per-token value.

## Data availability for Orion

| metric | source type | endpoint / contract / slug | notes |
|---|---|---|---|
| price, mcap, circ | coingecko | `bitway` | |
| revenue | defillama | `bitway-earn` dailyRevenue | Earn vault revenue only |
| holder flow | none | n/a | none exists |
| supply | erc20_supply | BSC `0x4440...ACaA` | fixed 10B |
| unlocks | manual | white paper (Google Doc linked from docs.bitway.com) | |

No flow to read on EVM because none exists.

## Orion mapping

- Modules: `forward_multiple` on revenue only (market convention, labeled as company/protocol revenue, not a holder claim), weight 1.0; `holder_cashflow` would be zero unless an assumed future capture is added (bull only).
- holder_flows: none.
- Assumptions: revenue growth from AUM; multiple on protocol revenue; bull scenario could include a hypothetical fee share, clearly marked.
- Obstacles: no token claim on revenue; price up about 65x from May 2026 ($0.014) to $0.92; heavy unlocks from March 2027.

## Sources

- https://api.coingecko.com/api/v3/coins/bitway (supply, contracts; 2026-09-22)
- https://api.llama.fi/summary/fees/bitway-earn?dataType=dailyRevenue / dailyFees / dailyHoldersRevenue (revenue, methodology; 2026-09-22)
- https://docs.bitway.com/llms.txt and https://docs.bitway.com/resources/btw-bitway-token.md (products, token utility; 2026-09-22)
- https://docs.google.com/document/d/1gOCmterg2UdL6kSu2y5O6yzF7hw2CIuECaUpJ34-B4I (English white paper: allocation, vesting, revenue model, roadmap; 2026-09-22)
- https://bsc-dataseed.binance.org eth_call `totalSupply()` (2026-09-22)
- https://coins.llama.fi/chart/coingecko:bitway (price history; 2026-09-22)
