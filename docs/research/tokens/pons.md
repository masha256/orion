# pons (PONS)

Researched 2026-09-22. Rank #48 by market cap (layer-1 tokens, stablecoins and tokenized RWAs excluded). Market cap $0.48B, FDV $0.48B, price $0.7052 (CoinGecko, 2026-09-22).
Chain(s): Robinhood Chain (EVM, chain id 4663; token `0x39dbed3a2bd333467115de45665cc57f813c4571`). CoinGecko id: `pons`. DefiLlama slugs: `pons-v1`, `pons-v2` (parent `pons`).

## Verdict

Orion fit: B. pons is a memecoin launchpad on Robinhood Chain, run by Pons Labs, LLC. It has very large, DefiLlama-published revenue: $25.3M over 30 days and $3.0M over the last 7 days. 80% of protocol fees go to a TWAP buyback that sends PONS to the burn address, and DefiLlama tracks it as holders revenue ($15.0M over 30 days). The docs say the buyback is manual for now ("not immutable yet"), the chain is new with no known public RPC for Orion, and launchpad volume is extremely volatile (the September peak is already fading).

- A: revenue-funded holder flow exists, is measurable (on-chain or DefiLlama), and revenue is published. Config-only or near config-only in Orion.
- B: real revenue and a holder flow exist but something is hard: off-chain data, discretionary capture, non-EVM chain needing an adapter, or an equity layer that keeps most value.
- C: revenue exists but nothing reaches holders today (fee switch off, all to validators/treasury), or the flow is inflation-funded; a valuation would rest entirely on an assumed future capture.
- D: no revenue model (store of value, meme, pure inflation staking). Not suitable.

## Business and revenue

pons is a noncustodial launch-and-trade interface for fixed-supply tokens on Robinhood Chain.
- v1 (from July 2026): tokens launch straight into WETH pools. 1% swap fee plus 0.0005 ETH per launch.
- v2: launches on a bonding curve, then graduate into a permanently locked Uniswap v4 pool whose hook charges the swap fee. The fee is split between creator and protocol: current launches creator 70% / protocol 30% from block 8,991,118; legacy launches 90/10. Creators can opt to divert part of their share into buybacks of their own token. Launch fees go to the protocol. Public launching is currently closed (whitelist); the docs show a Sept 2026 backend-upgrade banner.
Operator: Pons Labs, LLC (docs footer). It keeps the 20% of protocol fees not used for buybacks ("infrastructure costs and expanding the pons team").

DefiLlama (parent `pons`, 2026-09-22): fees 30d $145.2M, 7d $19.6M; revenue 30d $25,289,100, 7d $2,978,802, since launch (2026-07-14) $31,556,784. Weekly revenue: W29-W34 (mid-Jul to Aug) $0.5-2.5M/week; W35 $3.0M; W36 $9.8M; W37 $8.0M; W38 $3.6M; W39 (2 days) $0.9M. v2 accounts for most of it (v2 revenue 30d $23.5M). Annualized: 30d ≈ $308M, 7d ≈ $155M. Both are peak-biased.

## Holder flows

- id `pons_buyback_burn`, kind `burn` (protocol buybacks "buy PONS and send it to the burn address"), capture_rule `discretionary` (docs: "A manual buyback is running via an automated TWAP using 80% of protocol fees. This amount is not immutable yet, but will be immutable, decentralized, and automated in a future release"), recipient_base `all`.
- Trailing: DefiLlama holders revenue 30d $14,983,478 (≈ $182M annualized), 7d $1,598,379 (≈ $83M annualized), since launch $18,100,844. Weekly: W36 $3.9M, W37 $7.0M, W38 $3.5M, W39 (2 days) $0.13M. DefiLlama methodology: "Around 80% of revenue is used to buyback and burn $PONS tokens". The series sits under the `pons-v1` slug but covers the parent.
- Observability: on-chain on Robinhood Chain (PONS `Transfer` to the burn address). The v2 docs list a "Buyback vault" `0x42df2a798f82289E177311362e8f5ccC45c1219c`, but that vault is for creator-token buybacks (locked and vested over 5 years), not PONS. The PONS buyback executor address was not identified.
- History: started with the July 2026 launch. The announced change (making the 80% immutable and automated) has no date.

Capture rate today: $14.98M / $25.29M (30d) = 59%; since launch $18.10M / $31.56M = 57%. That is below the stated 80%, probably TWAP lag or accounting differences (open question).

## Supply

Max 1,000,000,000 PONS. CoinGecko total = circulating = 684,450,885 (2026-09-22), so about 315.5M is apparently treated as burned or excluded. At the prices seen since July ($0.04 to $0.97), $18M of buybacks cannot account for 315M tokens, so the gap likely includes other burns or supply exclusions (unconfirmed; allocation and vesting docs not found). No emissions or staking. The docs define "burn-adjusted market cap = price × (total supply − burned supply)". Price rose from about $0.04 (July) to $0.97 ATH (2026-09-05), now $0.71. supply_basis: `effective_total` (total minus burn-address balance), after confirming the burn-address balance on-chain.

## Data availability for Orion

| metric | source type | endpoint / contract / slug | notes |
|---|---|---|---|
| price, mcap, circ | coingecko | `pons` | |
| revenue | defillama | `pons` (parent) dailyRevenue; `pons-v2` | |
| holder flow | defillama | `pons` / `pons-v1` dailyHoldersRevenue | buyback-and-burn |
| burned supply | erc20_supply / contract_read | Robinhood Chain PONS `balanceOf(burn address)` | needs a Robinhood Chain RPC; the public RPC endpoints tried did not resolve (unknown) |
| launch/market data | http_json | https://www.ponsfamily.com/api/pons-launches, /api/pons-market/{token} | project API |

EVM chain, so `contract_read`/`transfer_flow` work once an RPC URL is configured. Until then DefiLlama is the path.

## Orion mapping

- Modules: `holder_cashflow` 0.5, `forward_multiple` on holder_flow 0.3, `forward_multiple` on revenue 0.2.
- holder_flows: `pons_buyback_burn` (burn, discretionary, all). Use a trailing window longer than 7 days, and in bear/base scenarios decay it sharply from the September peak.
- Assumptions: revenue decay (memecoin launchpads such as pump.fun show boom-bust cycles), terminal capture 60-80% with a discretionary haircut, low launchpad multiples.
- Obstacles: two-month history, peak-biased trailing numbers, discretionary buyback, new chain RPC, unexplained supply gap, launches currently whitelist-only.

## Sources

- https://api.coingecko.com/api/v3/coins/pons (supply, chain; 2026-09-22)
- https://api.llama.fi/summary/fees/pons?dataType=dailyRevenue / dailyHoldersRevenue / dailyFees, and pons-v1 / pons-v2 (figures, methodology, breakdown; 2026-09-22)
- https://docs.ponsfamily.com/llms.txt (chain id, contracts, v1/v2 overview; 2026-09-22)
- https://docs.ponsfamily.com/v2 (fees, creator/protocol split, creator buyback vault, hook sweeps; 2026-09-22)
- https://docs.ponsfamily.com/ (protocol revenue 80% buyback via TWAP, "not immutable yet", burn-adjusted market cap; 2026-09-22)
- https://ponsfamily.com/ (product; 2026-09-22)
- https://coins.llama.fi/chart/coingecko:pons (price in July 2026; 2026-09-22)
