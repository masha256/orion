# Hyperliquid (HYPE)

Researched 2026-09-22. Rank #1 by market cap (layer-1 tokens, stablecoins and tokenized RWAs excluded). Market cap $21.6B, FDV $92.8B, price $97.05 (CoinGecko, 2026-09-22).
Chain(s): Hyperliquid L1 (HyperCore + HyperEVM). CoinGecko id: `hyperliquid`. DefiLlama slug: `hyperliquid` (parent; children `hyperliquid-perps`, `hyperliquid-spot-orderbook`, `hyperliquid-hlp`).

Note on scope: Hyperliquid runs its own chain, but HYPE is kept in this universe as an application token. The revenue that matters is the exchange's trading fees, not block rewards. L1 gas (`hyperliquid-l1`, $11.0M/1y, burned) is small next to exchange fees.

## Verdict

Orion fit: A. About 99% of non-builder trading fees buy HYPE into the Assistance Fund automatically, and the docs now say that HYPE is burned. DefiLlama publishes this as holders revenue (1y $692M), and the Hyperliquid info API shows the fund's balance. It is config-only with `defillama`, plus an optional `http_json` cross-check.

## Business and revenue

- Fees: perp and spot taker/maker fees on HyperCore, including HIP-3 builder-deployed perps. Traders pay them. The fees go to the Assistance Fund (AF, about 99%), the HLP vault (1% since 2025-08-30, 3% before) and deployers. HIP-3 and spot deployers can keep up to 50% of the fees on their markets. Builder-code fees go to front-ends. There is no company take: "fees are entirely directed to the community (HLP, the assistance fund, and deployers)" (docs, fees page).
- DefiLlama `hyperliquid` (2026-09-22): fees 30d $74.5M, 1y $916.1M. Revenue 30d $58.2M, 1y $692.1M, all-time $1.27B. Holders revenue is identical to revenue.
- Run rate: 30d x 365/30 = $708M, close to the 1y figure. Monthly holders revenue for perps fell from $107.5M (2025-08) to $37-58M a month in 2026 (DefiLlama chart). The trend is lower than in 2025 and flat through 2026.
- Equity layer: Hyperliquid Labs is private and self-funded and takes no fee cut. The protocol fee does not leak to any company. HIP-3 deployer shares and builder fees are outside revenue by construction.
- New revenue lines: aligned quote assets. Under AQAv2, stablecoin issuers such as USDH share about 90% of cost-adjusted reserve yield on Hyperliquid supply, and the share is sent automatically to the AF every 30 days. The AF held 43,220 USDH on 2026-09-22 (info API), so the amounts are small so far.

## Holder flows

- id `af_buyback_burn`, kind burn, capture_rule programmatic, recipient_base all
  - Trailing: $692.1M over 1y, $58.2M over 30d ($708M annualized) (DefiLlama holders revenue, 2026-09-22).
  - Observability: the AF system address `0xfefefefefefefefefefefefefefefefefefefefe` converts fees to HYPE "in a fully automated manner as part of the L1 execution. HYPE in the assistance fund is burned, removing the tokens permanently from the circulating and total supply" (docs, fees page, read 2026-09-22). The info API `spotClearinghouseState` for that address shows 47,419,087 HYPE with an entry notional (cost) of $1.313B on 2026-09-22.
  - Burn vs hold: the fund started (early 2025) as buy-and-hold. The docs now describe it as a burn, and CoinGecko's total supply (955.3M) nets it out. But the info API `tokenDetails` still reports totalSupply 998,916,415 and lists the AF under `nonCirculatingUserBalances`. Treat it as a burn, recipient_base all. The exact date of the change (a validator vote, around late 2025) is unconfirmed.
  - Rule and control: the fee split is set in the L1 protocol and changes only by network upgrade or validator vote, so capture_rule is programmatic. The HLP share was cut from 3% to 1% on 2025-08-30 (DefiLlama methodology).
- id `hip1_auction_burn`, kind burn: HYPE paid in HIP-1 ticker auctions and slashed HIP-3 stake are burned. This is small and is included in the spot adapter.
- id `hlp_share`: 1% of fees to HLP depositors. This is supply-side, not a holder flow.

Capture rate today: holders revenue / revenue = $692.1M / $692.1M = 100% (DefiLlama excludes builder fees from revenue). Against total fees including builder and deployer fees it is $692.1M / $916.1M = 76%.

## Supply

- Max 1,000,000,000. Hyperliquid info API `tokenDetails` (2026-09-22): totalSupply 998,916,415 (about 1.08M burned via gas and auctions), circulatingSupply 298,758,215. Non-circulating: 241,394,583 at `0x43e9abea1910387c4292bca4b94de81462f8a251` (unvested contributor/foundation tokens, attribution unconfirmed) and 47,419,087 in the AF. futureEmissions: 411,342,854.
- CoinGecko (2026-09-22): circulating 222,445,714, total 955,307,079. Tokenomist says 22.24% is released. The API's 298.8M count includes staked genesis tokens that CoinGecko treats differently. Use CoinGecko for market cap.
- Effective total: 998.9M - 47.4M AF = 951.5M (CoinGecko 955.3M). supply_basis recommendation: `effective_total`. The large unvested team and emissions tranches will enter supply, and a per-token DCF on circulating supply would overstate value.
- Allocation (tokenomist, 2026-09-22): 38.89% future emissions and community rewards, 31.0% genesis, 23.8% core contributors, 6.0% foundation, 0.3% grants.
- Emissions: staking rewards come "from the future emissions reserve". The rate is inversely proportional to the square root of total stake, about 2.37% a year at 400M staked (docs, staking page). The staking yield is 100% inflation, and there is no fee component. Treat it as dilution: roughly 2-2.5% a year on staked supply, about 9-10M HYPE a year, from the 411M reserve (estimate).
- Unlocks: core-contributor tokens vest monthly after a one-year cliff from TGE (2024-11-29). Tokenomist gives the next unlock as 2026-10-06, released to core contributors, with the schedule running into 2027. The monthly size is not shown on the page. Roughly 238M over about 24 months, around 10M a month, is unconfirmed. This is the main supply overhang against the burn: about 10M HYPE a month unlocked against about 6-7M HYPE a month bought at $97 ($58M/30d).

## Data availability for Orion

| metric | source type | endpoint / contract / slug | notes |
|---|---|---|---|
| revenue_run_rate_usd | defillama | `hyperliquid`, dataType dailyRevenue | 30d and 1y available |
| holder flow (burn) | defillama | `hyperliquid`, dataType dailyHoldersRevenue | equals revenue |
| AF HYPE balance (cross-check) | http_json | POST api.hyperliquid.xyz/info `{"type":"spotClearinghouseState","user":"0xfefe...fefe"}` | the change in balance x price gives the flow |
| supply (total, circulating, emissions reserve) | http_json | POST api.hyperliquid.xyz/info `{"type":"tokenDetails","tokenId":"0x0d01dc56dcaaca66ad901c959b4011ec"}` | totalSupply still includes the AF |
| price / market cap | coingecko | `hyperliquid` | |
| unlock schedule | manual | tokenomist.ai/hyperliquid | monthly sizes unconfirmed |

An EVM RPC cannot read the flow, because the AF lives on HyperCore. The HyperEVM does not expose HyperCore balances through standard ERC-20 calls. Use DefiLlama or the info API through `http_json`.

## Orion mapping

- Modules: holder_cashflow 0.6 (burn flow per effective token), forward_multiple on holder_flow 0.25, forward_multiple on revenue 0.15. Revenue and holder flow are nearly identical here.
- holder_flows: `[{id: af_buyback_burn, kind: burn, capture_rule: programmatic, recipient_base: all, source: defillama hyperliquid dailyHoldersRevenue}]`.
- Assumptions needed: revenue growth (volume share vs CEXs; HIP-3 growth vs the deployer fee share, which lowers the protocol's cut per dollar of volume), terminal capture 0.9-1.0, and multiples.
- Emissions: a step schedule for the staking reward reserve plus the monthly core-contributor unlocks, which need to be researched. Staking yield must not be counted as value.
- Obstacles: the burn vs hold status differs between the docs (burn) and the API (non-circulating, still in total supply). The Orion supply config must subtract the AF balance explicitly. The team unlock sizes are not confirmed.

## Sources

- https://api.llama.fi/summary/fees/hyperliquid?dataType=dailyRevenue / dailyHoldersRevenue / dailyFees: revenue, holders revenue, fees (accessed 2026-09-22)
- https://api.llama.fi/summary/fees/hyperliquid-perps?dataType=dailyHoldersRevenue and hyperliquid-spot-orderbook: methodology text (99% to AF, HLP 1% since 2025-08-30) and monthly chart (accessed 2026-09-22)
- https://api.llama.fi/overview/fees: child slugs including hyperliquid-l1 and hyperliquid-hlp (accessed 2026-09-22)
- https://api.hyperliquid.xyz/info (spotClearinghouseState for 0xfefe..., tokenDetails for HYPE): AF balance, cost basis, total/circulating/non-circulating supply, futureEmissions (accessed 2026-09-22)
- https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees.md: fee destinations, AF address, the burn statement, HIP-3 deployer share (accessed 2026-09-22)
- https://hyperliquid.gitbook.io/hyperliquid-docs/hypercore/staking.md: staking rewards from the future emissions reserve, about 2.37% at 400M staked (accessed 2026-09-22)
- https://hyperliquid.gitbook.io/hyperliquid-docs/hypercore/aligned-quote-assets.md: AQAv2 reserve-yield share to the AF (accessed 2026-09-22)
- https://hyperliquid.gitbook.io/hyperliquid-docs/hyperliquid-improvement-proposals-hips/hip-3-builder-deployed-perpetuals.md: HIP-3 stake, slashing burn, fee share (accessed 2026-09-22)
- https://tokenomist.ai/hyperliquid: allocation, next unlock 2026-10-06, 22.24% released (accessed 2026-09-22)
- https://api.coingecko.com/api/v3/coins/markets?ids=hyperliquid: circulating, total, max (accessed 2026-09-22)
