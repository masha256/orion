# Pyth Network (PYTH)

Researched 2026-09-22. Rank #42 by market cap (layer-1 tokens, stablecoins and tokenized RWAs excluded). Market cap $0.52B, FDV $0.66B, price $0.066123 (CoinGecko, 2026-09-22).
Chain(s): Solana (SPL `HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3`); bridged copies on Neon EVM and Manta. CoinGecko id: `pyth-network`. DefiLlama slugs: `pyth-pro`, `pyth-core`, `pyth-entropy`, `pyth-express-relay` (parent `pyth`).

## Verdict

Orion fit: B. Pyth has real, growing, published revenue. Pyth Pro subscriptions pay 60% to the DAO: $1.93M in the last year, and the latest monthly distribution annualizes to about $5.2M. Since Dec 2025 the DAO has spent part of its treasury on open-market PYTH purchases that it holds in the treasury (buy_and_hold). But each purchase is voted monthly, runs on Solana, is reported only on the forum and is not in DefiLlama holders revenue, and the final unlock of about 2.13B PYTH (27% of circulating) is due in May 2027.

- A: revenue-funded holder flow exists, is measurable (on-chain or DefiLlama), and revenue is published. Config-only or near config-only in Orion.
- B: real revenue and a holder flow exist but something is hard: off-chain data, discretionary capture, non-EVM chain needing an adapter, or an equity layer that keeps most value.
- C: revenue exists but nothing reaches holders today (fee switch off, all to validators/treasury), or the flow is inflation-funded; a valuation would rest entirely on an assumed future capture.
- D: no revenue model (store of value, meme, pure inflation staking). Not suitable.

## Business and revenue

Pyth is a first-party oracle network. Revenue lines:
- Pyth Pro (formerly Lazer): off-chain institutional data subscriptions sold by Douro Labs as official distributor. Douro keeps 40% and sends 60% to the Pyth DAO treasury (CO-PIP-9), in USDC or directly in PYTH. DefiLlama `pyth-pro`: gross 1y $3,209,568, DAO revenue 1y $1,925,739. Distributions arrive monthly with about a one-month lag: gross Mar 2026 $180k, Apr $178k, May $413k, Jun $241k, Jul $498k, Aug $501k, Sep (for August) $723k. The Sep figure annualizes to $8.7M gross / $5.2M DAO.
- Pyth Core on-chain update fees (governance-set `singleUpdateFeeInWei`) to the DAO: 1y $354,383, 30d about $0 (fees accrue in chain contracts and are repatriated irregularly).
- Entropy: 1y revenue $13,259. Express Relay: fees 1y $22,534. Price-feed listing fees: over $300k since 2025 (Phase 3 post).
- A community forum post (2026-09-09) cites "overall ARR $10.4M in August" including Pyth Indices ($1.59M fixed ARR). Unofficial.
Company layer: Douro Labs keeps 40% of Pro revenue. Publishers are paid separately.

## Holder flows

- id `pyth_strategic_reserve`, kind `buy_and_hold` (PYTH returned to and held by the DAO treasury, not burned), capture_rule `discretionary` today (each month's transfer is a separate DAO OP-PIP vote; execution by the Pythian Council within fixed guardrails). It would become `programmatic` if Strategic Reserve V2 passes. recipient_base `all`.
- Mechanism (OP-PIP-87, passed Dec 2025): each month 1/3 of the DAO's non-PYTH treasury balance goes to the Council Ops multisig `GAdn7TZhszf5KTfwNRx3A2nP6KCRFEWucZubgdEqbJA2`, is swapped for PYTH (max $25k per trade, max 5% slippage), and the PYTH returns to the DAO treasury.
- Reported purchases (forum PYTH Purchases Reports): Dec 2025 2.157M PYTH; Jan 2026 2.16M; Mar 123,327 USDC + 4.78 SOL for 2.752M PYTH; Jun about 1.80M; Jul 38,552 USDC + 101.92 SOL for 1.145M; Aug 25,701 USDC + 67.95 SOL for 0.670M. Feb, Apr and May reports exist but were not opened. Trailing 12-month estimate: about 15-17M PYTH, about $0.7-1.0M (analyst estimate from the reports; unconfirmed total). Purchases are shrinking because the 1/3-of-balance rule decays while Douro pays more in PYTH directly.
- Douro PYTH payments: part of the DAO's 60% share is paid in PYTH. The V2 proposal counts these as "completed PYTH accumulation". Economically this is revenue converted to PYTH and held.
- Announced change: "Pyth Strategic Reserve V2" (forum, 2026-09-09, proposal stage) would direct 100% of the DAO share of the Pyth Pro umbrella (subscriptions, LaaS, Marketplace, Indices), plus existing non-PYTH treasury assets and Core/Entropy fees, into PYTH accumulation under a standing authorization. If it passes, capture is about 100% of DAO revenue.
- No fee_share to stakers: governance staking earns nothing. Oracle Integrity Staking rewards (about 7M PYTH/month from a pre-allocated pool, i.e. emissions) were proposed to sunset when the pool ran out in early March 2026 (Phase 3; final status unconfirmed).

Capture rate today: about $0.8M purchases / about $2.3M DAO revenue (Pro $1.93M + Core $0.35M + Entropy $0.01M, 1y) ≈ 35%. Against gross revenue including Douro's share ($3.6M) it is about 22%. Under V2: about 100% of DAO revenue.

## Supply

Max/total 10,000,000,000 PYTH. Circulating 7,874,959,922 (78.7%, CoinGecko); FDV/mcap 1.27x. Unlock schedule: cliffs at 6/18/30/42 months after the Nov 2023 TGE. The May 2026 unlock (about 2.13B, "May 19th") has happened; the final unlock of about 2.125B PYTH is due about May 2027 (from memory of the published schedule; consistent with the 2.125B still locked). No burns. Emissions: OIS rewards came from the pre-minted ecosystem allocation, not new mint; about 1B+ PYTH staked (Dune, Feb 2026). Staking yield: inflation/allocation-funded, not fee-funded. supply_basis: `effective_total` (10B, since the final cliff is under 12 months away); DAO-held PYTH could be netted out if the reserve is treated as non-circulating.

## Data availability for Orion

| metric | source type | endpoint / contract / slug | notes |
|---|---|---|---|
| price, mcap, circ | coingecko | `pyth-network` | |
| revenue (Pro) | defillama | `pyth-pro` dailyRevenue (DAO 60%) / dailyFees (gross) | monthly lumps, lag 1 month |
| revenue (Core, Entropy) | defillama | `pyth-core`, `pyth-entropy` | small |
| holder flow (reserve purchases) | adapter / manual | Solana transfers into DAO treasury `Gx4MBPb1vqZLJajZmsKLg8fGw9ErhoKsR8LeKcCKFyak` from the Ops multisig `GAdn7T...JA2`; forum monthly reports | DefiLlama holders revenue ≈ 0 (not tracked) |
| unlocks | manual | May 2027 cliff about 2.125B | |

Non-EVM (Solana); no EVM RPC can read the flow. It needs a Solana adapter (for example an http_json against a Solana RPC or an indexer), or the monthly forum reports entered manually.

## Orion mapping

- Modules: `holder_cashflow` 0.4, `forward_multiple` on revenue 0.4 (DAO revenue; label Douro's 40% as excluded), `forward_multiple` on holder_flow 0.2.
- holder_flows: `pyth_strategic_reserve` (buy_and_hold, discretionary → programmatic if V2 passes, all), trailing about $0.8M. Bull/base could lift terminal capture toward 100% of DAO revenue if V2 passes.
- Supply: step unlock of +2.125B in May 2027.
- Assumptions: Pro revenue growth (strong, about 4x in six months), terminal capture 35-100%, oracle/data multiples.
- Obstacles: Solana-only flow data; buy-and-hold into a DAO treasury that could later spend the tokens; forum-reported amounts; the May 2027 unlock.

## Sources

- https://api.coingecko.com/api/v3/coins/pyth-network (supply; 2026-09-22)
- https://api.llama.fi/summary/fees/pyth-pro, pyth-core, pyth-entropy, pyth (revenue, holders revenue; 2026-09-22)
- https://raw.githubusercontent.com/DefiLlama/dimension-adapters/master/fees/pyth-pro/index.ts (Douro/DAO wallets, 60/40 split; 2026-09-22)
- https://forum.pyth.network/t/passed-op-pip-87-pyth-token-phase-2-pyth-strategic-reserve/2293 (reserve mechanism, multisig, guardrails; 2026-09-22)
- https://forum.pyth.network/t/pyth-token-phase-3/2350 (OIS emissions about 7M/month, purchases, Pro revenue Sep 2025-Jan 2026; 2026-09-22)
- https://forum.pyth.network/t/march-2026-pyth-purchases-report/2435, /july-2026-pyth-purchases-report/2658, /august-2026-pyth-purchases-report/2691 (purchase amounts; 2026-09-22)
- https://forum.pyth.network/t/pyth-strategic-reserve-v2-aligning-pyth-accumulation-with-pyth-pro-revenue/2696 (V2 proposal, ARR claim, purchase history; 2026-09-22)
- https://forum.pyth.network/t/no-demand-excessive-supply-a-critical-call-for-strategic-burn-before-the-43-inflation-hit/2334 (May 19 unlock of 2.13B; 2026-09-22)
- https://forum.pyth.network/search.json?q=buyback and ?q=reserve (topic index; 2026-09-22)
