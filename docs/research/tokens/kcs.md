# KuCoin Token (KCS)

Researched 2026-09-22. Rank #30 by market cap (layer-1 tokens, stablecoins and tokenized RWAs excluded). Market cap $1.02B, FDV $1.05B, price $7.40 (CoinGecko, 2026-09-22).
Chain(s): KCC (KuCoin Community Chain, EVM, native coin; the burns go to 0x…dEaD there), plus a legacy Ethereum ERC-20 `0xf34960d9d60be18cc1d5afc1a6f012a723a28811` (static supply of 165.6M). CoinGecko id: `kucoin-shares`. DefiLlama slug: `kcc` (chain fees only, $1.5k over one year).

## Verdict

Orion fit: C. KCS's monthly buyback-and-burn was small ($0.2-1.0M a month in late 2025) and appears to have stopped after the December 2025 burn. The "KCS Bonus" has an unverified source and size. KuCoin publishes no revenue. Little reaches holders today.

## Business and revenue

KuCoin, a private exchange, earns trading fees and keeps them. It publishes no revenue or profit. The KuCoin KCS page says the monthly burn amount is "calculated based on KuCoin's overall monthly revenue", with no percentage given. In January 2025 KuCoin pleaded guilty in the US and exited the US market (context from memory, unconfirmed here). A June 2026 review headline calls this "the US indictment".

## Holder flows

- id `kcs_monthly_burn`, kind burn, capture_rule discretionary, recipient_base all.
  - Disclosed: September 2025, 83,696 KCS, about $1.04M (announcement 2025-09-26). December 2025, 20,240 KCS, about $244k (66th burn, 2025-12-31; KCC tx 0xa07457b0…, to 0x…dEaD). October and November 2025 together: about 16.9k KCS (derived).
  - On-chain check: the KCC 0x…dEaD native balance was 26,781,718.33 at the December 2025 burn block and 26,781,718.79 now (2026-09-23; eth_getBalance on rpc-mainnet.kcc.network). No burn has occurred since. The KuCoin announcement search shows no 2026 burns either.
  - Trailing 12 months: 120,830 KCS, about $1.5M, all of it in September to December 2025. The current run rate is $0.
- id `kcs_bonus` (the claimed 10% of net profit paid as a KCS bonus to holders), kind fee_share, capture_rule discretionary, recipient_base staked. This could not be confirmed. The KuCoin KCS page shows only a staking "reference APR 0.94%" and a loyalty tier multiplier, with no stated source. If it is revenue-funded, a rough size is 0.94% × staked KCS × price. The staked amount is unknown. With a guessed 50M KCS staked, it would be about $3.5M a year (unconfirmed).
- CoinGecko's description (old text) says KuCoin shares 50% of trading fees with KCS holders. That is out of date (2018-2019 era).

Capture rate today: about $0 of burn (plus an unverified bonus) / KuCoin revenue (unpublished).

## Supply

Initial 200M; the target is to burn down to 100M. Total 142,155,021.74 (CoinGecko matches the December 2025 announcement exactly, so the total has not changed since). CoinGecko circulating is 137.16M; the December 2025 announcement said 129.66M. No emissions found, and no unlocks found. supply_basis: effective_total (142.16M).

## Data availability for Orion

| metric | source type | endpoint / contract / slug | notes |
|---|---|---|---|
| price, supply | coingecko | `kucoin-shares` | |
| burn | contract_read | KCC RPC `https://rpc-mainnet.kcc.network` eth_getBalance(0x…dEaD) | EVM-compatible; native-coin balance, not an ERC-20 |
| bonus | manual | KuCoin KCS page | source and size unverified |
| revenue | manual | none published | |

An EVM RPC (KCC) can read the burn, but it needs a native-balance read rather than an ERC-20 read.

## Orion mapping

- Modules: forward_multiple on revenue (labeled, on an estimate of KuCoin revenue). holder_cashflow only if the burns resume or the bonus is verified.
- holder_flows: `kcs_monthly_burn` {burn, discretionary, all, trailing $1.5M/yr, current 0}; `kcs_bonus` {fee_share, discretionary, staked, unknown}.
- Open question: did KuCoin formally suspend the burn in 2026? Ask KuCoin or check its announcements.

## Sources

- https://www.kucoin.com/kcs (burn based on monthly revenue, staking APR 0.94%; 2026-09-22)
- https://www.kucoin.com/announcement/search?keyword=KCS%20Burn (burn list, none in 2026; 2026-09-22)
- https://www.kucoin.com/announcement/en-kcs-team-completes-66th-december-2025-kcs-burn (December 2025 burn, supply; 2026-09-22)
- https://www.kucoin.com/announcement/en-kcs-team-completes-63rd-september-2025-kcs-burn (September 2025 burn; 2026-09-22)
- https://rpc-mainnet.kcc.network JSON-RPC (burn tx receipt, dead-address balance; 2026-09-23)
- https://api.coingecko.com/api/v3/coins/markets?ids=kucoin-shares and /coins/kucoin-shares (supply, description; 2026-09-22)
