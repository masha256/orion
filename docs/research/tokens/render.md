# Render (RENDER)

Researched 2026-09-22. Rank #32 by market cap (layer-1 tokens, stablecoins and tokenized RWAs excluded). Market cap $0.95B, FDV $0.98B, price $1.83 (CoinGecko, 2026-09-22).
Chain(s): Solana (SPL `rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof`, canonical since 2023-11-02); legacy RNDR ERC-20 on Ethereum `0x6de037ef9ad2725eb40118bb1702ebb27e4aeb24` (not yet upgraded). CoinGecko id: `render-token`. DefiLlama slug: `render-network-bme`.

## Verdict

Orion fit: A. Under the Burn-Mint Equilibrium, job spend priced in USD is burned as RENDER on Solana: 95% of gross fees, about $1.74M in the last year. DefiLlama publishes it as holders revenue, so Orion can read it from config. But fixed governance emissions of 5.9M RENDER a year (about $10.8M) exceed burns by about 6x, so net supply still grows about 1% a year.

- A: revenue-funded holder flow exists, is measurable (on-chain or DefiLlama), and revenue is published. Config-only or near config-only in Orion.
- B: real revenue and a holder flow exist but something is hard: off-chain data, discretionary capture, non-EVM chain needing an adapter, or an equity layer that keeps most value.
- C: revenue exists but nothing reaches holders today (fee switch off, all to validators/treasury), or the flow is inflation-funded; a valuation would rest entirely on an assumed future capture.
- D: no revenue model (store of value, meme, pure inflation staking). Not suitable.

## Business and revenue

Render is a decentralized GPU network (OTOY origin) for 3D rendering and, since RNP-019/RNP-021 (2025), a compute subnet for AI and enterprise workloads. Creators pay jobs priced in USD/EUR. Under BME (RNP-001, revised RNP-006), the RENDER equivalent of the job is burned by the burn wallet `rbrnm7nPhfhBxPSh8qhRFrhB5MLnJGMNoyNQPvSi7vq` on Solana. Node operators are paid from separate emissions, not from the burn. OTOY, the network operator, receives a 5% service fee off-chain.

DefiLlama `render-network-bme` (2026-09-22): fees = revenue 30d $211,566, 1y $1,833,822, all-time $3,054,231 (gross = burn / 0.95); holders revenue (the 95% burned) 30d $200,999, 1y $1,742,151. Monthly holders revenue: Aug 2025 $291k, Sep $453k, Oct $153k, Nov $156k, Dec $169k, Jan 2026 $120k, Feb $93k, Mar $175k, Apr $220k, May $87k, Jun $81k, Jul $156k, Aug $114k, Sep 1-22 $174k. Flat to down over 12 months, while the Foundation reported usage +87% YoY in 2025 in EUR terms (RNP-022). Part of the work may sit outside the on-chain burn stream (open question). OTOY is a private company; the only thing the token receives is the burn.

## Holder flows

- id `render_bme_burn`, kind `burn`, capture_rule `programmatic` (BME is a governance-enacted rule, RNP-001; the burn is run by the Foundation's automated burn process, not by an immutable contract), recipient_base `all`.
- Trailing annualized: $1,742,151 (DefiLlama holders revenue, 1y); 30d annualized $2.41M. Observable on Solana as SPL `burn`/`burnChecked` from the burn wallet (DefiLlama uses Allium).
- History: BME live since the Solana upgrade (Nov 2023). Year 1 emissions 9.13M (RNP-006), Year 2 5.9M (RNP-018), Year 3 5.9M (RNP-022, created 2025-12-05, implemented). Salad Network migration to RENDER approved (RNP-023, 2026-03-26), a possible demand source.

Capture rate today: $1.742M burn / $1.834M gross job revenue = 95%.

## Supply

Max 644,245,094 RENDER (536.9M legacy RNDR + 107.4M BME emissions, RNP-001). Total 533.5M, circulating 518.8M (CoinGecko). Effective total = total net of burns (DefiLlama cumulative burns about $2.9M, probably about 1-1.5M RENDER at historical prices; unconfirmed in tokens). About 23% of legacy RNDR was not upgraded as of Oct 2025 (423M upgraded, RNP-022). Gross emissions: 5.9M RENDER/yr in Year 3 (Dec 2025 to about Dec 2026), split 1.5M artist/AI grants, 1.5M node rewards (rendering + compute), 2.9M operations/R&D/growth; RNP-001 prescribes a damping coefficient of 0.945 after year 5. Next year's allocation needs a new RNP (known schedule suggests about 5.9M again). No holder staking yield. Emissions of about 1.1% of supply a year against burns of about 0.18% a year. supply_basis: `effective_total`.

## Data availability for Orion

| metric | source type | endpoint / contract / slug | notes |
|---|---|---|---|
| price, mcap, circ | coingecko | `render-token` | |
| revenue | defillama | `render-network-bme` dailyFees | gross job spend derived from burns |
| holder flow | defillama | `render-network-bme` dailyHoldersRevenue | 95% burn |
| emissions | manual | RNP-018 / RNP-022 | 5.9M/yr step schedule |
| supply | http_json / adapter | Solana RPC `getTokenSupply` on the mint | non-EVM; ETH legacy via erc20_supply |

The flow is on Solana; no EVM RPC can read it, but DefiLlama covers it.

## Orion mapping

- Modules: `holder_cashflow` 0.6, `forward_multiple` on revenue 0.2, `forward_multiple` on holder_flow 0.2.
- holder_flows: `render_bme_burn` (burn, programmatic, all) from defillama holders revenue.
- Emissions: step schedule 5.9M RENDER/yr (Year 3), then a declining path per RNP-001; staker share 0.
- Assumptions: revenue growth (AI compute rollout is the bull case), terminal capture 95%, multiples in the DePIN range.
- Obstacles: emissions far exceed burns; on-chain burns may lag reported network usage; EUR-priced jobs.

## Sources

- https://api.coingecko.com/api/v3/coins/render-token (supply; 2026-09-22)
- https://api.llama.fi/summary/fees/render-network-bme?dataType=dailyFees / dailyRevenue / dailyHoldersRevenue (figures, methodology; 2026-09-22)
- https://raw.githubusercontent.com/DefiLlama/dimension-adapters/master/fees/render-network.ts (burn wallet, method; 2026-09-22)
- https://know.rendernetwork.com/basics/burn-mint-equilibrium (BME, Year 1-2 emissions; 2026-09-22)
- https://github.com/rendernetwork/RNPs/blob/main/RNP-001.md (BME, 107.4M emissions pool, damping 0.945; 2026-09-22)
- https://raw.githubusercontent.com/rendernetwork/RNPs/main/RNP-018.md and RNP-022.md (Year 2/3 emissions 5.9M and allocations, upgrade share; 2026-09-22)
- https://raw.githubusercontent.com/rendernetwork/RNPs/main/RNP-023.md (Salad migration; 2026-09-22)
