# Lighter (LIT)

Researched 2026-09-22. Rank #25 by market cap (layer-1 tokens, stablecoins and tokenized RWAs excluded). Market cap $1.2B, FDV $4.9B, price $4.92 (CoinGecko, 2026-09-22).
Chain(s): Ethereum (ERC-20 `0x232ce3bd40fcd6f80f3d55a522d03f25df784ee2`) and Robinhood Chain (`0xeeca2e7dc194a320d349122d88259bb9595a4cb0`). Trading and buybacks happen on Lighter, a zk-rollup exchange. CoinGecko id: `lighter`. DefiLlama slug: `lighter` (children `lighter-perps`, `lighter-spot`, `lighter-robinhood-perps`).

## Verdict

Orion fit: B. Treasury buybacks of LIT funded by trading fees exist and are measured on DefiLlama (holders revenue, read from Lighter's explorer API). But the execution is discretionary ("flexibility to use shorter timeframes"), the bought LIT sits in the treasury, and the token is new. A 25% float and a large unlock start in Dec 2026.

## Business and revenue

- Lighter is a perp and spot orderbook DEX.
- Standard accounts trade free. Premium accounts pay 0.004% maker / 0.028% taker, with staking discounts up to 30%; Plus accounts pay 0.5 bp. There are also transfer and withdraw fees. Liquidation fees go to the LLP (docs, trading-fees; DefiLlama methodology).
- DefiLlama `lighter` parent (2026-09-22):
  - Revenue: 30d $4.46M (about $54M annualized); since start (Oct 2025) $61.5M.
  - Monthly revenue: peak $14.3M (Nov 2025), $2.2-3.2M a month (Apr-Sep 2026).
- Company layer: Lighter is a venture-backed company. The investors hold a 24% LIT allocation. Any equity arrangement is unknown.

## Holder flows

- `lit_treasury_buyback`: kind buy_and_hold (LIT bought into the treasury, account index 0); capture_rule discretionary; recipient_base all.
  - Trailing annualized: $36.8M from 30d ($3.03M); cumulative since Jan 2026 $28.2M.
  - Source: DefiLlama `lighter` dailyHoldersRevenue, computed from treasury-account-0 trades on market 2049 (LIT/USDC) via `https://explorer.elliot.ai/api/accounts/0/logs?pub_data_type=Trade`.
  - Docs: "LIT is bought back by the protocol using trading fee revenue. Buybacks are executed via daily 24-hour TWAPs, with the flexibility to use shorter timeframes".
  - History: buybacks began Jan 2026 ($6.7M that month). Since then they have run at roughly 70-100% of monthly revenue (Sep 2026 to date: $1.8M of $3.0M).
- `lit_staking_apr` (possible fee_share to staked, unclear): stakers receive a fixed 6% APR. "LIT is bought from `0xADbE1265C0df1B623A56d324De494Bcb8e8914Ff` for these rewards" (docs, lit-utility).
  - It is unclear whether this is paid from the buyback inventory, so it may double-count with the buyback, or from separate purchases. Treat it as part of the buyback until confirmed.
  - Staking also gates access to the LLP (10 USDC per LIT).
- No burns.

Capture rate today: $3.03M / $4.46M = 68% (30d, DefiLlama).

## Supply

- Total/max 1.0B. Circulating 250M (CoinGecko). That is the Season 1-2 airdrop, 25%, unlocked 2025-12-29 (DefiLlama emissions).
- Allocation per DefiLlama: airdrop 250M; team about 260M; investors about 240M; ecosystem remainder, about 250M, for future points seasons and partnerships, with no published schedule. Unconfirmed against an official tokenomics page, since the docs have none.
- supply_basis: `circulating` plus the explicit unlock schedule. Bought-back LIT held by the treasury should be netted out if the treasury balance can be read.
- Unlocks: team and investors start linear vesting on 2026-12-29 at about 1.66M plus 1.53M LIT a week (about 166M a year) until about 2029-12-28.
  - Next 12 months: about 122M (about 49% of today's float).
  - Next 24 months: about 288M.
  - Ecosystem releases are additional and unscheduled.
- Staking yield: fixed 6% (source discussed above). Staked ratio unknown.

## Data availability for Orion

| metric | source type | endpoint / contract / slug | notes |
|---|---|---|---|
| revenue | defillama | `lighter` dailyRevenue | |
| holder flow | defillama | `lighter` dailyHoldersRevenue | from Lighter explorer API |
| holder flow cross-check | http_json | `https://explorer.elliot.ai/api/accounts/0/logs?pub_data_type=Trade&limit=100` | paginated; would need summing, so adapter-lite |
| price, supply | coingecko | `lighter` | |
| unlocks | http_json | `https://defillama-datasets.llama.fi/emissions/lighter` | ecosystem tranche missing |

An EVM RPC can read LIT supply on Ethereum. The buyback happens on the Lighter rollup, not in an EVM contract.

## Orion mapping

- Modules: holder_cashflow 40% (`lit_treasury_buyback`, buy_and_hold, discretionary, all); forward_multiple on holder_flow 30%; forward_multiple on revenue 30%.
- Assumptions:
  - Revenue growth. Revenue fell about 80% from the Nov 2025 peak and is now stable.
  - Terminal capture: base 60-70%, bear 30%.
  - Unlock dilution of about 166M a year from Dec 2026, plus ecosystem.
  - A haircut because treasury-held LIT can be re-released.
- Open questions: the official allocation table; whether staking rewards come from buybacks; the treasury LIT balance.

## Sources

- https://docs.lighter.xyz/about-lighter/lit-utility.md: staking, 6% APR, buyback description (2026-09-22)
- https://docs.lighter.xyz/trading/trading-fees.md: fee schedule (2026-09-22)
- https://api.llama.fi/summary/fees/lighter (dailyFees, dailyRevenue, dailyHoldersRevenue) and /lighter-perps methodology (2026-09-22)
- https://raw.githubusercontent.com/DefiLlama/dimension-adapters/master/fees/lighterv2/index.ts: buyback computation, treasury account 0, market 2049 (2026-09-22)
- https://defillama-datasets.llama.fi/emissions/lighter: airdrop and vesting (2026-09-22)
- https://api.coingecko.com/api/v3/coins/lighter: contracts; /coins/markets: supply (2026-09-22)
