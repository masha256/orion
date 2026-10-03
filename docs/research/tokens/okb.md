# OKB (OKB)

Researched 2026-09-22. Rank #9 by market cap (layer-1 tokens, stablecoins and tokenized RWAs excluded). Market cap $2.6B, FDV $2.6B, price $122.51 (CoinGecko, 2026-09-22).
Chain(s): X Layer (OKX's Polygon-CDK L2, where OKB is the gas token) and Ethereum (ERC-20 `0x75231f58b43240c9718dd58b4967c5114342a86c`). CoinGecko id: `okb`. DefiLlama slug: `x-layer` (chain fees; OKX itself is not listed).

## Verdict

Orion fit: C. The August 2025 one-off burn fixed supply at 21M and ended the quarterly buyback-and-burn. OKX's revenue no longer reaches the token in any committed way. The only ongoing flow is X Layer gas burn, which is tiny.

## Business and revenue

OKX, a private company, earns exchange revenue, keeps it and publishes none. X Layer gas fees: $320k in fees over one year (DefiLlama `x-layer` dailyFees, total1y). The DefiLlama revenue is labeled "Burned coins": $71.8k over one year, $42.8k over 30 days (methodology: "Revenue: Burned coins"; 2026-09-22).

## Holder flows

- id `okb_xlayer_gas_burn`, kind burn, capture_rule programmatic (chain fee parameters), recipient_base all. Trailing: $71.8k per year (DefiLlama `x-layer` dailyRevenue total1y). The last 30 days ($42.8k) annualize to about $0.5M. It is observable on DefiLlama.
- Ended flow: the quarterly OKX buyback-and-burn (2019 to 2025). The OKX announcement of 2025-08-13 said 65,256,712.097 OKB (historical repurchases plus treasury reserve) would be burned on 2025-08-15. Total supply is then fixed at 21M. The contract upgrade on 2025-08-18 removed the mint and burn functions. Any OKB sent to the blackhole address is burned automatically, but OKX made no ongoing buyback commitment.
- There are no fee_share flows.

Capture rate today: about $0.07-0.5M a year / OKX revenue (unpublished), which is effectively 0%.

## Supply

Fixed at 21,000,000 total, max and circulating (CoinGecko, 2026-09-22). No emissions and no unlocks. The Ethereum ERC-20 totalSupply is 429,065 OKB, down from 666,592 a year earlier (eth.drpc.org). The Ethereum representation is shrinking; most OKB lives on X Layer or on the exchange. That reading is an inference, unconfirmed. supply_basis: circulating is the same as effective_total (21M).

## Data availability for Orion

| metric | source type | endpoint / contract / slug | notes |
|---|---|---|---|
| price, supply | coingecko | `okb` | |
| gas burn | defillama | `x-layer` dailyRevenue | tiny |
| OKX revenue | manual | none published | |

An EVM RPC could read X Layer, but the flow is too small to matter.

## Orion mapping

- Modules: forward_multiple on revenue only, as a labeled market convention on an estimated OKX revenue. holder_cashflow would be close to 0 unless an assumed future capture is added.
- holder_flows: `okb_xlayer_gas_burn` {burn, programmatic, all, about $0.1-0.5M/yr}.
- Obstacles: the token has no claim on OKX economics after August 2025. Any valuation rests on assumed future buybacks or on utility demand. OKX revenue is unpublished.

## Sources

- https://www.okx.com/help/announcement-on-the-pp-upgrade-of-x-layer-and-optimisation-of-the-okb-gas (one-off burn, 21M cap, end of repurchases, contract upgrade; 2026-09-22)
- https://yellow.com/news/okx-burns-dollar76b-worth-of-okb-tokens-cuts-supply-by-52 (burn context; 2026-09-22)
- https://api.llama.fi/summary/fees/x-layer?dataType=dailyRevenue and ?dataType=dailyFees (gas burn; 2026-09-22)
- https://api.coingecko.com/api/v3/coins/markets?ids=okb (price, supply; 2026-09-22)
- https://eth.drpc.org JSON-RPC (ERC-20 totalSupply; 2026-09-23)
