# Rain (RAIN)

Researched 2026-09-22. Rank #4 by market cap (layer-1 tokens, stablecoins and tokenized RWAs excluded). Market cap $9.3B, FDV $14.9B, price $0.01309 (CoinGecko, 2026-09-22).
Chain(s): Arbitrum One (ERC-20 `0x25118290e6a5f4139381d072181157035864099d`; bridges to Ethereum, BNB Chain, Base). CoinGecko id: `rain`. DefiLlama slug: `rain`.

## Verdict

Orion fit: B. A small prediction-market/options protocol whose platform fees fund a buyback-and-burn that DefiLlama tracks and Arbitrum `totalSupply` confirms, but the burn is discretionary by the issuer's own MiCA white paper, and holder flow of about $1M a year against a $9.3B market cap (about 9,400x) means Orion will value it at a small fraction of the market price.

- A: revenue-funded holder flow exists, is measurable (on-chain or DefiLlama), and revenue is published. Config-only or near config-only in Orion.
- B: real revenue and a holder flow exist but something is hard: off-chain data, discretionary capture, non-EVM chain needing an adapter, or an equity layer that keeps most value.
- C: revenue exists but nothing reaches holders today (fee switch off, all to validators/treasury), or the flow is inflation-funded; a valuation would rest entirely on an assumed future capture.
- D: no revenue model (store of value, meme, pure inflation staking). Not suitable.

## Business and revenue

Rain is a permissionless prediction-market / custom-options protocol on Arbitrum. Anyone creates a market; public markets resolve with an AI oracle agent, private ones with a creator-appointed resolver. Users trade in USDT. Fees paid per pool are split among the platform, pool creators, referrers and resolvers (DefiLlama adapter reads `PlatformClaim`, `CreatorClaim`, `RefererClaim`, `ResolverClaim` events on the pool factory contracts `0xccCB3C03...23F1` and `0xA8640B62...F264`). CoinGecko describes the platform take as "2.5% of trading volume allocated to buy and burn". The issuer is a Panama entity; no equity layer is disclosed.

DefiLlama (fetched 2026-09-22): fees 30d $110,836, 1y $1,507,272; revenue = holders revenue 30d $75,752, 1y $986,738, all-time $989,179. Monthly revenue: Oct 2025 $36k, Nov $85k, Dec $47k, Jan 2026 $46k, Feb $11k, Mar $13k, Apr ~0, May $408k (spike), Jun $142k, Jul $102k, Aug $97k, Sep 1-22 ~$0 (7d and 24h both 0). Activity looks lumpy and has stalled in September.

## Holder flows

- id `rain_buyback_burn`, kind `burn`, capture_rule `discretionary`, recipient_base `all`.
- Trailing annualized: $986,738 (DefiLlama holders revenue, 1y to 2026-09-22); 30d annualized ~$0.92M. Caveat: DefiLlama counts the USDT platform-fee claims and *assumes* they are used to buy back and burn; it does not observe the burn itself.
- On-chain confirmation: Arbitrum `totalSupply()` = 1,142,408,486,749 RAIN vs 1,150,000,000,000 max (read 2026-09-22), so about 7.59B RAIN has been burned via a supply-reducing burn. The dead address holds only 415 RAIN. Orion can track `totalSupply` via `erc20_supply` on Arbitrum.
- History: burns visible from about Sept 2025. The MiCA white paper (published 2026-03-26) says: "The buyback-and-burn mechanism is discretionary, depends on protocol parameters and governance decisions ... may be modified, suspended, or discontinued." DAO governance, planned for Q4 2025, is still not active per that paper; until then the Rain Team may change token rights.

Capture rate today: $986,738 holders revenue / $986,738 revenue = 100% of protocol revenue (DefiLlama definition); against gross fees $1,507,272 it is 65%.

## Supply

Max 1.15T RAIN. Total 1,142.4B (net of about 7.6B burned). Circulating 709.2B (CoinGecko) = 62% of total; FDV gap 1.6x. Issuer-retained: 157B RAIN (MiCA white paper G.5). Allocations (presale, strategic sale, contributors, advisors, team, marketing/dev, liquidity, ecosystem, reserves) vest over 6-24 months from the 2025-03-24 listing (white paper); exact per-category schedule not found (unknown), so remaining unlocks of about 433B RAIN over the next months are likely but undated. The white paper also says "limited new tokens may be issued to fund development and community rewards" although max supply is fixed at 1.15T. No staking. supply_basis: `effective_total` (burns reduce `totalSupply`; large issuer-retained and vesting tranches make circulating unreliable).

## Data availability for Orion

| metric | source type | endpoint / contract / slug | notes |
|---|---|---|---|
| price, mcap, circ | coingecko | `rain` | |
| revenue | defillama | `rain` dailyRevenue | USDT platform-fee claims |
| holder flow | defillama | `rain` dailyHoldersRevenue | same series as revenue; burn assumed |
| burned supply | erc20_supply | Arbitrum `0x2511...099d` `totalSupply()` vs 1.15T | EVM RPC reads it; confirms burns |
| burn tx flow | transfer_flow | Arbitrum, Transfer to `0x0` from buyback wallet | buyback wallet address not identified (unknown) |
| unlocks | manual | none published | |

An EVM RPC can read the burn (supply reduction) directly.

## Orion mapping

- Modules: `holder_cashflow` 0.6, `forward_multiple` on holder_flow 0.4 (revenue = holder flow, so a revenue multiple adds nothing).
- holder_flows: `rain_buyback_burn` (burn, discretionary, all), trailing $0.99M, source defillama `rain` holders revenue, cross-check `erc20_supply` delta.
- Assumptions: very wide revenue growth band (volume is spiky; bear should allow decline); terminal capture 50-100% with a discretionary haircut.
- Obstacles: market cap of $9.3B on ~$1M revenue is not explainable by cash flow; low float relative to FDV; burn is discretionary and centrally controlled; September activity near zero.

## Sources

- https://api.coingecko.com/api/v3/coins/rain (supply, links, description; 2026-09-22)
- https://api.llama.fi/summary/fees/rain?dataType=dailyRevenue / dailyHoldersRevenue / dailyFees (figures, methodology; 2026-09-22)
- https://raw.githubusercontent.com/DefiLlama/dimension-adapters/master/fees/rain-one/index.ts (what DefiLlama measures; 2026-09-22)
- https://whitepaper.rain.one (MiCA white paper, published 2026-03-26: supply, issuer-retained tokens, discretionary burn; 2026-09-22)
- https://arb1.arbitrum.io/rpc eth_call `totalSupply()` and dead-address balance on the RAIN contract (2026-09-22)
- https://coins.llama.fi/chart/coingecko:rain (price history, $0.004 Sept 2025 to $0.013 now; 2026-09-22)
