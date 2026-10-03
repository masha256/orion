# HTX DAO (HTX)

Researched 2026-09-22. Rank #22 by market cap (layer-1 tokens, stablecoins and tokenized RWAs excluded). Market cap $1.6B, FDV $1.6B, price $0.00000173 (CoinGecko, 2026-09-22).
Chain(s): Tron (TRC-20 `TUPM7K8REVzD2UdV4R5fe5M8XbnR2DdoJ6`, hex `0xca0303e8b9a738121777116dcea419fe524f271a`), also on Ethereum and BNB Chain (`0x61ec85ab89377db65762e234c946b5c25a56e99e`). CoinGecko id: `htx-dao`. DefiLlama slug: none.

## Verdict

Orion fit: B. A stated rule (the HTX exchange contributes 50% of its revenue each quarter to buy back and burn HTX) is backed by quarterly on-chain burns on Tron of about $14-23M. But the revenue base is undefined and unpublished, and the flow is on Tron.

## Business and revenue

The HTX exchange (formerly Huobi, associated with Justin Sun) earns trading fees and keeps them. HTX DAO's press releases state: "The HTX exchange, as an ecosystem partner of HTX DAO, provides 50% of its revenue each quarter to buy back and burn $HTX" (GlobeNewswire, 2026-01-16). The model is described as "Verified Revenue – Automatic Buyback – On-chain Burn", running since late 2023 (GlobeNewswire, 2025-04-17). Buybacks run through Sun.io. HTX publishes volume and user reports but no revenue figure.

Implied HTX revenue (burn × 2): Q4 2025 $46.6M; Q1 2026 $38.4M; Q2 2026 $27.2M. That is about $150M annualized over the last three quarters, and about $109M at the Q2 2026 run rate. What "revenue" covers is undefined. It may be one fee pool rather than consolidated revenue. Trend: down about 42% from Q4 2025 to Q2 2026.

## Holder flows

- id `htx_exchange_buyback_burn`, kind burn, capture_rule discretionary (a partner commitment, not enforced by any contract), recipient_base all.
  - Quarterly disclosures: Q1 2025, 11.338T HTX, about $19.2M. Q4 2024, $22M. Q4 2025, 13.616T HTX, $23.31M (tx `f2a20879…7228`, 2026-01-14). Q1 2026, 10.825T HTX, $19.22M (2026-04-15). Q2 2026, 7.475T HTX, about $13.6M (July 2026). H1 2026 total: $32.82M.
  - Q3 2025: about 13.12T HTX, inferred from "+3.78% QoQ". The USD figure was not found.
  - Trailing annualized: about $74.8M (three disclosed quarters, annualized). Q2 2026 run rate: about $54M.
  - Observable: burns are TRC-20 transfers to `T9yD14Nj9j7xAB4dbGeiX9h8unkKLxmGkn` (hex 0x…0001). Its balance is 101.757T HTX (TRON JSON-RPC `eth_call` balanceOf, 2026-09-22). That equals total 999.99T minus the CoinGecko total of 898.23T.
  - History: started late 2023. 2025 total: 99.49T cumulative, about $186.9M cumulative (press release). HTX DAO also reports "burned and pledged" (117.79T); only the burned part counts.

Capture rate today: 50% of HTX "revenue" by the stated rule, as the burn over implied revenue. It is unverifiable, because the denominator is unpublished.

## Supply

Total 999.99T minted. Burned 101.76T (on-chain), so the effective supply is 898.23T. CoinGecko shows circulating and total both at 898.23T. No emissions found. The burn is about 3.5% of supply a year at the current pace (press release: an average of about 5.5% a year over two years). supply_basis: effective_total, which here is the same as circulating.

## Data availability for Orion

| metric | source type | endpoint / contract / slug | notes |
|---|---|---|---|
| price, supply | coingecko | `htx-dao` | |
| burn (tokens) | contract_read (TRON JSON-RPC) or http_json | `https://api.trongrid.io/jsonrpc` eth_call balanceOf(0x…01) on `0xca0303e8…271a`; or the tronscan API | TRON supports eth_call but not getLogs; balance deltas work |
| burn (USD) | manual / derived | quarterly press releases | |
| revenue | manual | none published | implied at 2× the burn |

An EVM RPC works only through TRON's eth_call-compatible endpoint, which needs hex addresses. This is worth testing with Orion's contract_read.

## Orion mapping

- Modules: holder_cashflow 0.5, forward_multiple on holder_flow 0.3, forward_multiple on revenue 0.2 (implied revenue).
- holder_flows: `htx_exchange_buyback_burn` {burn, discretionary, all, trailing ≈ $55-75M/yr}.
- Assumptions needed: the trend in HTX exchange revenue (it is declining); persistence of the 50% commitment; key-person and governance risk (Justin Sun).
- Obstacles: the Tron data path; the undefined "revenue"; the TRC-20 contract does not reduce totalSupply, so effective supply is total minus the burn address balance.

## Sources

- https://www.globenewswire.com/news-release/2026/01/16/3220414/0/en/htx-quarterly-burn-hits-a-new-high-of-13-62-trillion-total-burn-volume-nears-10-of-total-supply.html (50% rule, Q4 2025; 2026-09-22)
- https://www.globenewswire.com/news-release/2026/07/17/3328956/0/en/htx-dao-burns-over-32-82-million-worth-of-htx-in-h1-2026-highlighting-strong-business-resilience.html (Q2 2026, H1 2026; 2026-09-22)
- https://www.globenewswire.com/news-release/2025/04/17/3063465/0/en/htx-dao-burns-11-3t-htx-in-q1-sustaining-deflationary-momentum-through-stable-burn-mechanism.html (Q1 2025, program history; 2026-09-22)
- https://yellow.com/press-releases/htx-dao-completes-q1-2026-htx-burn-two-year-supply-shrinks-over-11-as-deflation-accelerates (Q1 2026; 2026-09-22)
- https://apilist.tronscanapi.com/api/transaction-info?hash=f2a20879d33e1f08feedef2d2779bb1cd919e792dbc637201beedac44b897228 (burn address; 2026-09-22)
- https://api.trongrid.io/jsonrpc (totalSupply, burn address balance; 2026-09-22)
- https://api.coingecko.com/api/v3/coins/markets?ids=htx-dao (price, supply; 2026-09-22)
