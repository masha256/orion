# Curve DAO Token (CRV)

Researched 2026-09-22. Rank #41 by market cap (layer-1 tokens, stablecoins and tokenized RWAs excluded). Market cap $0.56B, FDV $0.87B, price $0.358629 (CoinGecko, 2026-09-22).
Chain(s): Ethereum (ERC-20 `0xD533a949740bb3306d119CC777fa900bA034cd52`). Pools are on many chains, and fees are bridged to Ethereum. CoinGecko id: `curve-dao-token`. DefiLlama slug: `curve-finance` (children `curve-dex`, `crvusd`, `curve-llamalend`, `curve-llamalend-v2`).

## Verdict

Orion fit: A. A contract-routed fee_share (admin fees and crvUSD interest converted to crvUSD) goes weekly to veCRV lockers through the FeeDistributor. It is on DefiLlama as holders revenue (1y $29.8M) and readable on Ethereum. Watch two things: DefiLlama's figure includes about $1.3M/yr of third-party bribes, and the flow has fallen sharply (30d ex-bribes about $0.48M).

## Business and revenue

- Fees: traders pay swap fees on Curve pools, and crvUSD and LlamaLend borrowers pay interest. Pool fees are split about 50/50 between LPs and the protocol's "admin fee". Of the admin share, 90% goes to veCRV and 10% to the DAO treasury (DefiLlama methodology). crvUSD interest goes to veCRV and the treasury after the share paid to scrvUSD savers.
- DefiLlama `curve-finance` (2026-09-22): fees 30d $3.56M, 1y $62.8M. Revenue 30d $1.06M, 1y $30.5M. Holders revenue 30d $1.00M, 1y $29.8M, all-time $312M.
- Bribes: `curve-dex` fees include bribes (third-party vote incentives from llama.box), about $1.26M over 1y and $0.52M over 30d (fees minus userFees: $59.33M - $58.07M over 1y; $3.35M - $2.82M over 30d). They are also counted in holders revenue. They are not protocol revenue and should be excluded.
- Trend: curve-dex holders revenue fell from $4.5-4.8M/month (Aug-Oct 2025) to $1.1M/month (Jul-Aug 2026) and $0.65M in September to date. crvUSD's contribution is small ($0.05-0.1M/month in 2026). Ex-bribes, the 30d run rate is about $5.9M/yr vs about $28.6M over 1y.
- Company layer: none takes fees. Curve's developer company (Swiss Stake AG) is funded by DAO grants and CRV vesting (unconfirmed).

## Holder flows

- id `vecrv_fee_share`, kind fee_share, capture_rule programmatic, recipient_base locked
  - Trailing (ex-bribes): about $28.6M over 1y (DefiLlama holders revenue $29.83M minus about $1.26M bribes). 30d about $0.48M ($1.00M minus $0.52M), about $5.9M annualized (DefiLlama, 2026-09-22).
  - Observability: the FeeDistributor `0xD16d5eC345Dd86Fb63C6a9C43c517210F1027914` has `token()` = crvUSD `0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E`, `last_token_time` 2026-09-22, and held 502,857 crvUSD pending claims (2026-09-22). The flow is readable as crvUSD Transfers into the distributor. A getLogs sweep was not completed because the free RPC limits the block range. veCRV (`0x5f3b5DfEb7B28CDbD7FAba78963EE202a494e2A2`) holds 846,806,592 CRV locked (35.0% of total supply, 54% of circulating). Voting power is 777.9M.
  - Rule and control: the admin fee share and the fee-to-crvUSD burner and hook contracts are set by Curve DAO (veCRV vote), so capture_rule is programmatic. Payouts switched from 3CRV to crvUSD in 2024 (unconfirmed exact date). The 90/10 veCRV/treasury split is per the DefiLlama methodology (date of the change unconfirmed).
  - Most veCRV is held via Convex (vlCVX) and other wrappers. Holders of liquid lockers receive the fee share indirectly.
- Bribes: kind fee_share, recipient_base locked, but paid by third parties, not revenue-funded. Exclude them from Orion's revenue-funded flow.

Capture rate today: holders revenue (ex-bribes) / revenue (ex-bribes) = $28.6M / $29.2M = about 98% over 1y (the rest is the 10% treasury share of admin fees, and crvUSD's split differs). Against total user fees it is $28.6M / $61.5M = 47%.

## Supply

- totalSupply 2,420,305,754 (Ethereum RPC, 2026-09-22). Max 3,030,303,031. Circulating 1,562,278,103 (CoinGecko). No burns, so effective = total.
- Emissions: the CRV `rate()` is 3.081 CRV/s, 97.16M CRV/yr (about 4.0% of supply, about $34.8M/yr at $0.3586). The current epoch started 2026-08-13 (`start_epoch_time` 1786573048). The rate drops by 2^(1/4), about 15.9%, every August 13, which is a known step schedule. All emissions go to LP gauges, not lockers, so they are dilution relative to the fee share. Gauge emissions ($34.8M/yr) currently exceed the fee share (1y $28.6M, 30d run rate $5.9M).
- Locked: 35.0% of total (54% of circulating). Many locks are max-length via Convex.
- supply_basis recommendation: `circulating`, with the emission schedule applied. The non-circulating part (total minus circulating, about 858M) is mostly veCRV-locked, which CoinGecko excludes. Given that, `effective_total` (2.42B) is the cleaner basis for a per-token DCF, because locked tokens hold the fee claim.
- Unlocks: the original team and investor vesting ended by 2024. The remaining dilution is the gauge emissions above.

## Data availability for Orion

| metric | source type | endpoint / contract / slug | notes |
|---|---|---|---|
| revenue_run_rate_usd | defillama | `curve-finance`, dailyRevenue minus bribes | bribes = dailyFees - dailyUserFees on `curve-dex` |
| holder flow (fee_share) | defillama / transfer_flow | `curve-finance` dailyHoldersRevenue; or crvUSD Transfer to `0xD16d...7914` | the on-chain route excludes bribes cleanly |
| locked ratio | contract_read | CRV.balanceOf(veCRV) / totalSupply | |
| emissions | contract_read | CRV.rate(), start_epoch_time() | step schedule |
| price / supply | coingecko | `curve-dao-token` | |

An EVM RPC (Ethereum) can read the flow through `transfer_flow` of crvUSD into the FeeDistributor.

## Orion mapping

- Modules: holder_cashflow 0.6 (fee_share to locked, emissions as dilution), forward_multiple on holder_flow 0.25, forward_multiple on revenue 0.15.
- holder_flows: `[{id: vecrv_fee_share, kind: fee_share, capture_rule: programmatic, recipient_base: locked, source: transfer_flow crvUSD -> FeeDistributor (preferred) or defillama curve-finance dailyHoldersRevenue minus bribes}]`. Locked ratio is 0.35 of total.
- Emissions: 97.16M CRV/yr until 2027-08-13, then x 0.841 each year.
- Assumptions: the steep 2026 decline (a 30d run rate about 5x below 1y) needs a view on whether volume recovers. Terminal capture about 0.9 of admin fees.
- Obstacles: bribes are mixed into DefiLlama holders revenue, and the flow has fallen sharply.

## Sources

- https://api.llama.fi/summary/fees/curve-finance?dataType=dailyRevenue / dailyHoldersRevenue / dailyFees (accessed 2026-09-22)
- https://api.llama.fi/summary/fees/curve-dex and crvusd?dataType=dailyHoldersRevenue: methodology (50% admin fee, 90% to veCRV, bribes included) and monthly series (accessed 2026-09-22)
- https://api.llama.fi/summary/fees/curve-dex?dataType=dailyUserFees: user fees ex-bribes (accessed 2026-09-22)
- https://raw.githubusercontent.com/DefiLlama/dimension-adapters/master/fees/curve.ts: bribe source (llama.box) and label handling (accessed 2026-09-22)
- Ethereum RPC (eth.drpc.org) via cast: CRV totalSupply/rate()/start_epoch_time(), veCRV locked balance and totalSupply, FeeDistributor token()/last_token_time()/admin(), crvUSD balance of the distributor (accessed 2026-09-22)
- https://api.coingecko.com/api/v3/coins/markets?ids=curve-dao-token: circulating, total, max (accessed 2026-09-22)
