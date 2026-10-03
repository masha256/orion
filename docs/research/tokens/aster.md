# Aster (ASTER)

Researched 2026-09-22. Rank #17 by market cap (layer-1 tokens, stablecoins and tokenized RWAs excluded). Market cap $2.0B, FDV $5.7B, price $0.728 (CoinGecko, 2026-09-22).
Chain(s): BNB Chain (BEP-20 `0x000Ae314E2A2172a039B26378814C252734f556A`). Staking runs on Aster Chain, Aster's own PoSA L1. CoinGecko id: `aster-2`. DefiLlama slug: `astherus` is the parent id but does not resolve on the summary endpoint; use child `aster-perps` (fees only).

## Verdict

Orion fit: B. Since 2026-06-17, 99% of daily platform fees buy back ASTER, which is paid to veASTER lockers, and an equal amount is burned from reserve. That is a real revenue-funded flow. But the rule is company-run, DefiLlama has fees only (no revenue or holders series), and the buyback wallet shows no activity on BNB Chain. Settlement is probably on Aster Chain.

## Business and revenue

- Aster is a perp and spot DEX (formerly Astherus/APX), with USDF and asset yield products.
- Fees: maker/taker trading fees paid by traders, plus a 50,000 USDT permissionless spot listing fee.
- DefiLlama `aster-perps` fees:
  - 30d $6.38M (about $77.7M annualized); 1y $437.4M.
  - Monthly: $136.6M in Sep 2025, $133.1M in Oct 2025, then a steady decline to $4.8-6.3M a month (Mar-Sep 2026).
  - Revenue and holders-revenue series: not available ("not found").
- Revenue = fees is a working assumption (the orderbook DEX keeps its fees; there is no LP split in the docs). It is unconfirmed.
- Company layer: Aster (the team and foundation treasury) runs the exchange. There is no disclosed equity, but core chain contracts and RPC are closed source (docs, Aster Chain overview).

## Holder flows

- `aster_fee_buyback_to_stakers`: kind fee_share (ASTER bought with fees and paid out as rewards); capture_rule discretionary (announced policy run by the team via daily TWAP, not an on-chain contract); recipient_base locked (veASTER, by lock weight × trading boost).
  - Trailing annualized: about $77M (estimated as 99% × 30d fees annualized). Not independently observed.
  - Observability: buyback wallet `0xa0edBaBcb48034e368de286b49F9603C7AfA1b60` (docs). On BNB Chain it holds 30 ASTER, has nonce 0 and no code (BSC RPC, 2026-09-22). It is not used as a BSC trading wallet, so settlement is probably on Aster Chain (unconfirmed). Listing-fee wallet: `0x39C473f4420e4ae9Ab3fe9e7ceDFc08F9684bB1a`.
  - History: earlier stage-based buyback programs ran in 2025 (not detailed here). The 2026-06-17 upgrade set 99% of fees to buyback, all distributed to veASTER.
- `aster_reserve_burn` (supply effect, not a revenue flow): for every ASTER bought back, an equal amount is burned from reserve, team allocation first, bi-weekly, until total supply reaches 3.0B.
  - This retires unissued or insider tokens rather than buying from the market. Orion should model it as a reduction in future unlocks and supply, not as a holder cash flow.
  - Observable: 204.26M ASTER sits at `0x...dEaD` on BNB Chain (BSC RPC balanceOf, 2026-09-22). totalSupply() still reads 8.0B because burns are transfers to the dead address. CoinGecko total is 7.796B, net of that.
- Base staking rewards (150k ASTER a week base plus 300k a week loyalty) are emissions from the Ecosystem allocation: inflation, not value.

Capture rate today: about 99% of fees go to lockers as a fee_share (estimated; about $77M / about $78M).

## Supply

- Max 8.0B. Effective (net of the dead-address burn) 7.796B. Circulating 2.71B (CoinGecko 2026-09-22).
- supply_basis: `circulating` plus the explicit reserve-burn and unlock schedule.
- Emissions:
  - The Ecosystem linear vest (78.4M a month) was replaced in Jan 2026 by staking emissions of 450k ASTER per weekly epoch: about 23.4M a year, about 0.9% of circulating (docs, DefiLlama notes). This is inflation.
- Unlocks:
  - Team 400M: 12-month cliff from TGE, then 10M a month for 40 months (docs). DefiLlama models linear from 2026-09-16 at about 2.3M a week (about 120M a year). Team tokens are burned first under the reserve-burn rule, which may largely cancel them.
  - Airdrop remainder over 80 months, subject to governance.
  - Treasury 560M locked until governance use.
  - Next 12 months per DefiLlama: about 147M; next 24 months: about 294M.
- Staked/locked ratio: unknown.

## Data availability for Orion

| metric | source type | endpoint / contract / slug | notes |
|---|---|---|---|
| fees | defillama | `aster-perps` dailyFees | no revenue or holders series |
| holder flow | manual / adapter | Aster Chain explorer (buyback wallet) | wallet inactive on BSC; Aster Chain not verified as EVM-RPC-readable |
| reserve burns | contract_read (EVM, BNB Chain) | ASTER `balanceOf(0x...dEaD)` | readable today |
| price, supply | coingecko | `aster-2` | |
| unlocks | http_json | `https://defillama-datasets.llama.fi/emissions/aster` | |

An EVM RPC (BSC) can read the burns but not, today, the buyback flow.

## Orion mapping

- Modules: holder_cashflow 40% with flow `aster_fee_buyback_to_stakers` (fee_share, discretionary, locked); forward_multiple on holder_flow 30%; forward_multiple on revenue (fees) 30%. Supply steps come from the reserve burn: burned amount = buyback amount until total supply reaches 3B.
- Assumptions: fee trajectory (bear: continued decay from the 2025 peak; volume quality is questionable), terminal capture 99% with a discount for discretion, locked ratio.
- Obstacles: no observed buyback series; the revenue definition is unconfirmed; the dependence on Aster Chain is closed source.

## Sources

- https://docs.asterdex.com/usdaster-token/tokenomics.md: allocation, 2026-06-17 upgrade, buyback and burn rules, wallets (2026-09-22)
- https://docs.asterdex.com/aster-chain/staking.md and /staking/how-staking-works.md: reward pools, veASTER (2026-09-22)
- https://docs.asterdex.com/aster-chain/overview.md: Aster Chain, closed-source core (2026-09-22)
- https://docs.asterdex.com/usdaster-token/overview.md: token address, max supply (2026-09-22)
- https://api.llama.fi/summary/fees/aster-perps?dataType=dailyFees: fees and monthly series (2026-09-22)
- https://bsc-dataseed.binance.org eth_call totalSupply / balanceOf(dead, buyback wallet), eth_getTransactionCount, eth_getCode (2026-09-22)
- https://defillama-datasets.llama.fi/emissions/aster: unlocks and emission notes (2026-09-22)
- https://api.coingecko.com/api/v3/coins/markets?ids=aster-2 (2026-09-22)
