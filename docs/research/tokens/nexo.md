# Nexo (NEXO)

Researched 2026-09-22. Rank #34 by market cap (layer-1 tokens, stablecoins and tokenized RWAs excluded). Market cap $0.88B, FDV $0.88B, price $0.879865 (CoinGecko, 2026-09-22).
Chain(s): Ethereum (ERC-20 `0xb62132e35a6c13ee1ee0f84dc5d40bad8d815206`), plus bridged versions on Polygon, Fantom and others. CoinGecko id: `nexo`. DefiLlama slug: none.

## Verdict

Orion fit: C. Nexo is a private CeFi lender and wealth platform that keeps its revenue. The 2019-2021 profit dividend no longer exists (end date unconfirmed). Buybacks are discretionary, go into a reserve rather than being burned, and none has been announced for 2025-2026. The "interest on NEXO" is paid in NEXO from company holdings, not as a revenue share.

## Business and revenue

Nexo earns interest spreads on crypto-backed loans, exchange and card fees. It is private and publishes no revenue or profit (its reserves attestation covers assets, not earnings). It returned to the US on 2026-02-16 with Bakkt-backed services (Business Wire, CoinDesk and Reuters headlines, February 2026). The prompt's "2025 US re-entry" actually happened in February 2026.

## Holder flows

- id `nexo_buyback_ipr` (historical): kind buy_and_hold, capture_rule discretionary, recipient_base all. $12M announced December 2020; $100M announced November 2021 and completed May 2022. More than $150M in total since 2020 (Binance Academy, 2026). Repurchased tokens go to the Investor Protection Reserve and are locked for at least 12 months before possible reuse for rewards or liquidity, so they are not burned. No 2025-2026 program was found. Trailing: $0 (unknown if there are unannounced purchases).
- id `nexo_dividend` (ended): kind fee_share. It paid 30% of net profits in 2019-2021, for example $6.128M on 2020-08-15 (Business Wire headline). It was discontinued later (date unconfirmed). Trailing: $0.
- The interest paid on NEXO (up to 9-12% a year for platform deposits) and the loyalty perks are paid in NEXO from company holdings and depend on keeping tokens on the platform. This is a discretionary platform incentive, economically closer to a treasury distribution than a revenue share. It is not counted.

Capture rate today: 0 (no observable revenue-funded flow).

## Supply

Fixed at 1B total and max. CoinGecko shows 1B circulating, but Binance Academy puts circulating at about 646M (August 2026), the rest being reserve and treasury holdings. Nothing is burned: the Ethereum dead-address balance is about 10.7 NEXO. No emissions. supply_basis: effective_total (1B) is conservative, because the reserve can be re-released at the company's discretion.

## Data availability for Orion

| metric | source type | endpoint / contract / slug | notes |
|---|---|---|---|
| price, supply | coingecko | `nexo` | circulating figure disputed |
| buybacks | manual | company announcements | none active |
| IPR wallet | contract_read | reserve address not identified | EVM, if the address is found |
| revenue | manual | none published | |

An EVM RPC could track the reserve wallet if its address were known. No live flow exists to read.

## Orion mapping

- Modules: forward_multiple on revenue only (labeled market convention, on an estimated Nexo revenue); holder_cashflow 0 unless a buyback program is assumed.
- holder_flows: none active; historical `nexo_buyback_ipr` {buy_and_hold, discretionary, all, 0}.
- Obstacles: no revenue disclosure; token value rests on platform utility (yield and loyalty) rather than cash flow.

## Sources

- https://www.binance.com/en/academy/articles/what-is-nexo-nexo (buyback history, IPR lock, circulating about 646M; 2026-09-22)
- https://nexo.com/nexo-token (interest and loyalty benefits; 2026-09-22)
- https://coinbureau.com/analysis/is-nexo-safe (attestation model, SEC settlement context; 2026-09-22)
- Google News RSS headlines: "Nexo Returns to the U.S." (Business Wire, 2026-02-16), "Nexo to Distribute $6,128,000 in Dividends on August 15, 2020" (Business Wire), "Nexo Launches Buyback Program, Commits Initial $12M" (Business Wire, 2020-12-03) (headlines; 2026-09-22)
- https://api.coingecko.com/api/v3/coins/markets?ids=nexo and /coins/nexo (supply, contracts; 2026-09-22)
- https://eth.drpc.org JSON-RPC (dead-address balance; 2026-09-23)
