# Sky (SKY), formerly Maker (MKR)

Researched 2026-09-22. Rank #21 by market cap (layer-1 tokens, stablecoins and tokenized RWAs excluded). Market cap $1.6B, FDV $1.6B, price $0.0692 (CoinGecko, 2026-09-22).
Chain(s): Ethereum (SKY ERC-20 `0x56072C95FAA701256059aa122697B133aDEd9279`; legacy MKR `0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2`). CoinGecko id: `sky`. DefiLlama slug: `sky` (children `sky-lending`, `sky-money`; the old `maker` slug no longer resolves).

## Verdict

Orion fit: B. Sky has published revenue ($207.8M over 1y) and two programmatic, EVM-readable holder flows, which DefiLlama combines as holders revenue ($63.2M over 1y). The flows are a USDS fee_share to staked SKY and a SKY buyback via the Smart Burn Engine. It is not A because bought SKY is not burned (the supply is unchanged, and the Pause Proxy passes the tokens on), so the buyback's value to holders is unclear. The flow has also fallen sharply in 2026.

## Business and revenue

- Fees: USDS/DAI borrowers pay stability fees (vaults, Spark/Grove "stars" allocations, RWA and USDC/PSM yield), plus liquidation and PSM fees. Savers (Sky Savings Rate, sUSDS) receive a large share. The rest is surplus, split by the Splitter between SKY buybacks and USDS rewards to SKY stakers.
- DefiLlama `sky` (2026-09-22): fees 30d $26.1M, 1y $395.8M. Revenue (fees minus savings rate) 30d $13.0M, 1y $207.8M, all-time $760M. Holders revenue 30d $4.33M, 1y $63.2M.
- Trend: holders revenue ran at $12M/month in Aug-Oct 2025, then $8.5M (Nov 2025-Jan 2026), $4.4M (Mar 2026) and about $1.1M/month (Apr-Jul 2026), recovering to $2.5-3.3M (Aug-Sep 2026). Revenue at the 30d rate is about $158M/yr vs $208M over 1y.
- Company or entity layer: none holds equity in revenue. Ecosystem actors (Sky Frontier Foundation, Spark/Grove star teams) are funded through DAO budgets.

## Holder flows

- id `sky_staking_usds`, kind fee_share, capture_rule programmatic, recipient_base staked
  - Trailing: $14.85M of USDS over 1y, $2.07M over 30d ($25.1M annualized). This is the change in `total_farmed` of the staking rewards farm `0x38e4254bd82ed5ee97cd1c4278faae748d998865` (Block Analitica API, 2026-09-22). The farm had 8,621,855,715 lsSKY staked (36.8% of supply) at an APY of 5.67% (2026-09-23 row).
  - This yield is paid in USDS from surplus, so it is fee-funded, not inflation.
- id `sky_smart_burn_buyback`, kind buy_and_hold, capture_rule programmatic, recipient_base all
  - Trailing: about $48.3M over 1y, about $2.26M over 30d ($27.5M annualized). Each is DefiLlama holders revenue minus the USDS rewards above. In tokens: 1,998.8M SKY cumulative since 2024-11-13 (Block Analitica `sky_cumulative_buyback`). Monthly: 136-154M SKY/month in Nov 2025-Jan 2026, 14-20M SKY/month in Apr-Jul 2026, 30.8M SKY in Sep 2026 to date.
  - Mechanism (on-chain, 2026-09-22): Vow → Splitter `0xBF7111F13386d23cb2Fba5A538107A73f6872bCF` with `burn()` = 0.55 (55% of each surplus kick to the flapper, 45% to the USDS farm) and `hop()` = 2,504 s between kicks. The flapper `0x374D9c3d5134052Bc558F432Afa1df6575f07407` swaps USDS for SKY on the Uniswap v2 SKY/USDS pair `0x2621CC0B3F3c079c1Db0E80794AA24976F0b9e3c` (`want()` 0.98, oracle `pip()`) and sends the SKY to the `receiver()` = Pause Proxy `0xBE8E3e3618f7474F8cB1d074A26afFef007E98FB`. The Pause Proxy holds only 35.1M SKY and no LP tokens, so bought SKY is passed on (likely funding SKY rewards programs; unconfirmed).
  - Despite the name, nothing is burned. SKY totalSupply is 23,459,804,204, essentially the full MKR-equivalent (CoinGecko max 23,462,665,147), and 0xdead holds 4.8 SKY. Treat this as buy_and_hold with a recycling haircut.
  - Rule and control: the Splitter share, kick size and hop are executive-vote parameters (SKY governance), so capture_rule is programmatic.
- Surplus buffer: the Vow's `hump` is set to max and `bump` = 0. Flapping runs through the Splitter. The buffer level is readable from Vat.dai(vow) and Vat.sin(vow) (652.8M and 705.0M rad-units on 2026-09-22). Netting against queued debt was not done, so the net buffer is unknown.

Capture rate today: holders revenue / revenue = $4.33M / $13.03M = 33% (30d), or $63.2M / $207.8M = 30% (1y). Of that, only the staking fee_share ($2.07M, 30d) is unambiguous value to holders.

## Supply

- SKY totalSupply 23,459,804,204. It includes about 2,072M SKY sitting in the MKR→SKY converter `0xA1Ea1bA18E88C381C724a75F23a130420C403f9a` for 84,771 unconverted MKR (24,000 SKY per MKR; MKR totalSupply 84,770.9 on 2026-09-22). So conversion is about 91% done. Circulating 23,424,726,276 (CoinGecko). There is no net burn.
- Emissions: none on SKY for stakers. Staker yield is USDS from surplus. SKY rewards to USDS depositors ("Sky Token Rewards") are paid from treasury SKY, which dilutes non-recipients (amount unconfirmed). This is likely where bought-back SKY goes.
- Locked/staked: 36.8% in the Staking Engine (lsSKY).
- supply_basis recommendation: `effective_total` (23.46B). Treasury SKY recirculates, and unconverted MKR is fully convertible.
- Unlocks: none scheduled. A delayed-upgrade penalty on MKR→SKY conversion was introduced in 2025 (unconfirmed details).

## Data availability for Orion

| metric | source type | endpoint / contract / slug | notes |
|---|---|---|---|
| revenue_run_rate_usd | defillama | `sky`, dailyRevenue | net of the savings rate; the latest day often lags (24h shows 0) |
| holder flows (combined) | defillama | `sky`, dailyHoldersRevenue | buybacks plus USDS staking rewards |
| staking fee_share | http_json | info-sky.blockanalitica.com/farms/0x38e4...8865/historic/?days_ago=9999 (`total_farmed`) | or `transfer_flow` of USDS into the farm |
| buyback in SKY | http_json | info-sky.blockanalitica.com/buyback/historic/?days_ago=9999&format=json | or flapper swap events |
| Splitter share | contract_read | Splitter.burn(), hop() | EVM |
| supply | erc20_supply / coingecko | SKY totalSupply | |

An EVM RPC can read all flows on Ethereum.

## Orion mapping

- Modules: holder_cashflow 0.5 (fee_share to staked, plus the buyback with a haircut), forward_multiple on revenue 0.3, forward_multiple on holder_flow 0.2.
- holder_flows: `[{id: sky_staking_usds, kind: fee_share, capture_rule: programmatic, recipient_base: staked}, {id: sky_smart_burn_buyback, kind: buy_and_hold, capture_rule: programmatic, recipient_base: all}]`.
- Assumptions: whether the savings-rate spread recovers, and the Splitter share (55/45 today). Include a haircut for recycled buyback SKY.
- Obstacles: the name "smart burn" is misleading, because tokens are not destroyed. The DefiLlama holders revenue combines two kinds, so a split needs the Block Analitica API. The surplus buffer and SKY rewards spending are not tracked here.

## Sources

- https://api.llama.fi/summary/fees/sky?dataType=dailyRevenue / dailyHoldersRevenue / dailyFees (accessed 2026-09-22)
- https://api.llama.fi/summary/fees/sky-lending?dataType=dailyHoldersRevenue: methodology and monthly series (accessed 2026-09-22)
- https://raw.githubusercontent.com/DefiLlama/dimension-adapters/master/fees/makerdao.ts: data sources (Block Analitica buyback and farm endpoints) (accessed 2026-09-22)
- https://info-sky.blockanalitica.com/buyback/historic/?days_ago=9999&format=json: daily and cumulative SKY buyback (accessed 2026-09-22)
- https://info-sky.blockanalitica.com/farms/0x38e4254bd82ed5ee97cd1c4278faae748d998865/historic/?days_ago=9999: USDS staking rewards, staked amount, APY (accessed 2026-09-22)
- Ethereum RPC (eth.drpc.org) via cast: Vow.flapper(), Splitter burn()/hop()/flapper()/farm(), flapper receiver()/pair()/want(), pair reserves, SKY/MKR totalSupply, SKY balances of the Pause Proxy, converter and 0xdead, Vat dai/sin of the Vow (accessed 2026-09-22)
- https://api.coingecko.com/api/v3/coins/markets?ids=sky: supply (accessed 2026-09-22)
