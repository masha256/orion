# PancakeSwap (CAKE)

Researched 2026-09-22. Rank #35 by market cap (layer-1 tokens, stablecoins and tokenized RWAs excluded). Market cap $0.81B, FDV $0.84B, price $2.54 (CoinGecko, 2026-09-22).
Chain(s): BNB Chain (BEP-20 `0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82`, the canonical supply and burn chain); bridged copies on Ethereum, opBNB, Polygon zkEVM, Aptos, Solana. CoinGecko id: `pancakeswap-token`. DefiLlama slug: `pancakeswap` (parent; children `pancakeswap-amm`, `pancakeswap-amm-v3`, `pancakeswap-infinity`, `pancakeswap-prediction`, `pancakeswap-lottery`, `pancakeswap-stableswap`).

## Verdict

Orion fit: A. A fixed share of swap fees (and of perps, lottery and launchpad fees) buys CAKE and burns it. DefiLlama publishes this as holders revenue ($56.9M over 1y, $4.9M over 30d), and the burns land at `0x...dEaD` on BNB Chain, where an EVM RPC can read them. Since Tokenomics 3.0 (April 2025) burns exceed emissions, so supply is falling.

## Business and revenue

- Fees: traders pay swap fees on PancakeSwap v2 (0.25%), v3 (0.01/0.05/0.25/1% tiers) and Infinity (v4-style hooks) pools, mostly on BNB Chain. Other products add revenue: perpetuals, prediction markets, lottery and CAKE.PAD. Per the DefiLlama methodology:
  - v2: LPs get 0.17%, the treasury 0.0225%, and 0.0575% goes to CAKE buyback and burn.
  - v3: 15% of the fee in the 0.01%/0.05% tiers and 23% in the 0.25%/1% tiers goes to buyback and burn; the rest goes to LPs and the treasury.
  - Infinity: 50% of protocol revenue goes to buyback and burn.
- DefiLlama `pancakeswap`, 2026-09-22:
  - Fees: 30d $22.2M, 1y $259.9M.
  - Revenue (protocol + burn): 30d $7.24M, 1y $86.8M.
  - Holders revenue: 30d $4.91M, 1y $56.9M.
- Trend: monthly holders revenue peaked at $17.4M in 2025-10 (the BNB Chain memecoin volume spike), then fell to $1.5M in 2026-07. It recovered to $3.9M in 2026-08, and 2026-09 was $3.97M for 22 days. The 30d run rate ($60M a year) is close to the 1y figure, but the series is volatile.
- Company layer: PancakeSwap is run by an anonymous core team ("the Chefs"). There is no equity token or disclosed company taking a revenue share. The treasury share of fees funds operations.

## Holder flows

- id `fee_buyback_burn`, kind burn, capture_rule programmatic, recipient_base all
  - Trailing: $56.9M over 1y and $4.91M over 30d ($59.8M annualized) (DefiLlama `pancakeswap` dailyHoldersRevenue, 2026-09-22). Sub-protocols over 1y: v3 $33.2M, v2 $17.4M, Infinity $1.5M; perps, prediction and lottery make up the rest.
  - Observability: burns are sent to `0x000000000000000000000000000000000000dEaD` on BNB Chain. On 2026-09-22 the burn address held 5,051,176,395 CAKE out of totalSupply() 5,387,735,435 (BNB Chain RPC, `balanceOf`/`totalSupply`). PancakeSwap runs a weekly "Monday burn" and a Dune dashboard (dune.com/pancakeswap/PancakeSwap-CAKE-Tokenomics). The fee shares are set in pool and fee-router contracts and changed by team proposals plus a CAKE Snapshot vote. The weekly buy-and-burn is carried out by the team, so the rule is programmatic but execution is operational.
  - History:
    - Tokenomics 3.0 (vote 0x79ef...; implemented 2025-04-23 to 2025-05-07) retired veCAKE, gauges and the 5% revenue share to veCAKE holders.
    - The veCAKE revenue share was redirected to the burn: the v3 low-tier burn rose from 10% to 15%.
    - Emissions were cut from about 29,000 to 20,000 CAKE/day, then to about 14,500 CAKE/day. The ecosystem fund was halved.
    - A one-off 5.29M CAKE from the old delegated pool was burned on 2025-04-21.
    - The hard cap was cut from 450M to 400M by vote on 2026-01-16.
    - Stated target: at least about 4% deflation a year and about 20% supply reduction by 2030.
  - There is no longer any fee_share: the veCAKE revenue share ended on 2025-05-07.

Capture rate today: holders revenue / protocol revenue = $56.9M / $86.8M = 65.5% (1y), or $4.91M / $7.24M = 68% (30d). Against gross fees it is $56.9M / $259.9M = 21.9%.

## Supply

- Minted totalSupply() 5,387,735,435 CAKE. The burn address holds 5,051,176,395, so total supply = 336,559,040 CAKE (BNB Chain RPC, 2026-09-22). CoinGecko total is 330,627,632 and circulating 318,995,589; the difference is CAKE locked forever in the legacy pool, which PancakeSwap counts as burned. Max supply 400M (hard cap).
- supply_basis recommendation: `effective_total` (about 330.6M, the CoinGecko total, which already nets out burns and the legacy lock). Circulating differs by only 3.5%.
- Gross emissions: about 14,500 CAKE/day, or about 5.3M CAKE/year (1.6% of supply), after the Tokenomics 3.0 phase 2 cut (PancakeSwap blog, 2025-04). Emissions go to farms, lottery and ecosystem growth. Later changes are unconfirmed.
- Burn: $56.9M over 1y at an average price of about $2 is roughly 25-30M CAKE burned, against about 5.3M emitted, so net deflation is about 6-7% a year (derived and unconfirmed; the Dune dashboard has the exact net figure).
- Staking: after the veCAKE sunset, Syrup pools pay emissions (inflation), not fees. There is no fee-funded staking yield.
- Unlocks: none. There are no team or investor vesting tranches, and all supply comes from emissions.

## Data availability for Orion

| metric | source type | endpoint / contract / slug | notes |
|---|---|---|---|
| revenue_run_rate_usd | defillama | `pancakeswap` dailyRevenue | protocol + burn share |
| gross fees | defillama | `pancakeswap` dailyFees | |
| holder flow (burn) | defillama | `pancakeswap` dailyHoldersRevenue | methodology per child adapter |
| burn in tokens | transfer_flow | CAKE `0x0E09...cE82` Transfer to `0x...dEaD`, BNB Chain | public BNB RPCs cap eth_getLogs at 50 blocks; needs a better RPC or chunking |
| total supply | contract_read / erc20_supply | totalSupply() - balanceOf(0xdead) | legacy locked pool also counts as burned |
| emissions | manual | docs + blog (14,500/day) | no API |
| price / circulating | coingecko | `pancakeswap-token` | |

An EVM RPC can read the flow: burns go to 0xdead on BNB Chain. The public RPC I used (1rpc.io/bnb) served only the latest state and limited log ranges, so historical burn series need an archive or indexer RPC.

## Orion mapping

- Modules: holder_cashflow 0.6, forward_multiple on holder_flow 0.25, forward_multiple on revenue 0.15.
- holder_flows: `[{id: fee_buyback_burn, kind: burn, capture_rule: programmatic, recipient_base: all, source: defillama pancakeswap dailyHoldersRevenue}]`.
- Assumptions: base holder flow is about $55-60M a year. Revenue growth follows BNB Chain DEX volume, which is highly cyclical: memecoin spikes in 2025-10 were followed by a 70% drop. Terminal capture is about 0.65 of revenue. Model emissions as a small step schedule (5.3M/year) against the burn.
- Obstacles: the burn is valued in USD by DefiLlama at execution time, while the token count is on-chain. The emission rate after mid-2025 is not in the docs. Fee shares are team-proposed and could be cut, for example to subsidize LPs.

## Sources

- https://api.llama.fi/summary/fees/pancakeswap?dataType=dailyHoldersRevenue (and dailyRevenue, dailyFees; children pancakeswap-amm, -amm-v3, -infinity): fees, revenue, holders revenue, methodology, monthly series (accessed 2026-09-22)
- https://docs.pancakeswap.finance/protocol/cake-tokenomics.md: Tokenomics 3.0 burn shares per product, 4%/yr deflation target, 400M cap (vote 2026-01-16), burn-address supply check (accessed 2026-09-22)
- https://docs.pancakeswap.finance/welcome-to-pancakeswap/vecake-sunset.md: veCAKE sunset dates, end of the 5% revenue share, burn raised from 10% to 15% (accessed 2026-09-22)
- https://blog.pancakeswap.finance/articles/implementation-of-cake-tokenomics-3-0-what-you-need-to-know: emission cut from 29,000 to 20,000 to 14,500 CAKE/day, 5.29M CAKE burn, 5.3M/yr reduction (accessed 2026-09-22)
- BNB Chain RPC https://1rpc.io/bnb: CAKE totalSupply() and balanceOf(0xdead) (accessed 2026-09-22)
- https://api.coingecko.com/api/v3/coins/pancakeswap-token: supply, market data (accessed 2026-09-22)
- https://coins.llama.fi/prices/historical: CAKE historical prices (accessed 2026-09-22)
