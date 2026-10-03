# Worldcoin (WLD)

Researched 2026-09-22. Rank #20 by market cap (layer-1 tokens, stablecoins and tokenized RWAs excluded). Market cap $1.7B, FDV $4.6B, price $0.461744 (CoinGecko, 2026-09-22).
Chain(s): World Chain (`0x2cFc85d8E48F8EAB294be644d9E25C3030863003`), Ethereum (`0x163f8C2467924be0ae7B5347228CABF260318753`), Optimism. CoinGecko id: `worldcoin-wld`. DefiLlama slug: `world-chain` (chain fees only).

## Verdict

Orion fit: D. WLD has no revenue model today.
- The token is distributed to verified humans ("user tokens", formerly Orb grants) and to operators from a 7.5B community allocation. Those are emissions.
- World Chain gas fees are about $0.23M a year and are not captured by WLD.
- The planned World ID fees, payable in WLD, with an option to burn part, were piloted "Q3 2025" per the whitepaper, but I found no live, measurable fee stream.
- The company, Tools for Humanity, keeps its own economics (Orb hardware, World App).

## Business and revenue

- World (formerly Worldcoin) is a proof-of-personhood network. Tools for Humanity (TFH, a private company with equity investors) builds the Orb and World App. The World Foundation (Cayman) governs the protocol and the WLD community treasury.
- Revenue:
  - World Chain gas fees (DefiLlama `world-chain`): 30d $19.2K, 1y $231K. The adapter labels L2 net fees "burned coins" generically; they go to the chain operator, not to WLD.
  - No DefiLlama revenue or holders revenue for World ID.
  - TFH revenue (Orb sales and services, if any) is not disclosed and stays with TFH equity.
- Planned World ID fees (whitepaper "Designing for Scale"): relying applications would pay a credential fee (to issuers such as the Foundation) plus a protocol fee, in WLD, enforced by a private-state blockchain. "The community may choose to... burn a share of the fees." The Foundation expected a first pilot in Q3 2025. Status in 2026 unconfirmed; I found no data series.

## Holder flows

- None.
- User tokens and Orb verification grants are emissions from the community allocation (a transfer to new users), not holder flows.
- A potential future `world_id_fee_burn` (burn, discretionary/programmatic, all) has no data.

Capture rate today: 0 (no revenue reaching WLD; revenue itself about $0.23M a year of chain gas).

## Supply

- Initial supply cap 10B WLD. The token is not upgradable, except that governance may enact inflation of up to 1.5% a year from 2038-07-24.
- Circulating 3,646,959,224 (CoinGecko, 2026-09-22).
- Allocation (whitepaper, as of 2025-04-28): World Community 75% (user tokens at least 60%, network operations at most 10%, ecosystem fund at most 5%), TFH team 11.1%, TFH investors 13.6%, TFH reserve 0.3%.
- Unlock schedule:
  - Community tokens unlock linearly per period: 0.5B at launch, then 3.5B over years 1-3 (to 2026-07), 1.75B over years 4-6 (2026-07 to 2029-07, about 583M a year), 0.875B over years 7-9 and 0.875B over years 10-15.
  - Circulation depends on the pace of user verification.
  - TFH team and investors: a 12-month lockup, then about 80% linear over 48 months and 20% over 24 months, concluding by the end of July 2028. The 24-month tranche ended around 2026-07. The remaining 48-month tranche is about 2.47B x 0.8 / 48, about 41M WLD a month (derived).
- Next 12 months: up to about 583M community plus about 490M TFH, about 1.07B WLD (about 29% of circulating) as an upper bound.
- supply_basis recommendation: `circulating`, with an explicit unlock schedule. The FDV is 2.7x the market cap.
- Staking: none.

## Data availability for Orion

| metric | source type | endpoint / contract / slug | notes |
|---|---|---|---|
| chain gas fees | defillama | `world-chain` dailyFees | not captured by WLD |
| World ID fees | none | not live / no series | |
| supply / unlocks | coingecko + manual | `worldcoin-wld`; whitepaper schedule; Dune dashboard | |
| holder flow | none | none | |

An EVM RPC could read WLD transfers on World Chain, but there is no revenue-funded flow.

## Orion mapping

- Not suitable. At most, a speculative bull scenario with World ID fees plus a partial burn and no base-case cash flow. If forced: forward_multiple on revenue with near-zero revenue, and heavy unlock dilution (about 1B WLD a year) in the supply model.
- Obstacles: no revenue, emissions-driven supply growth, and the equity layer (TFH) is separate from the token.

## Sources

- https://whitepaper.world.org/designing-for-scale: allocation, unlock periods, TFH lockups to July 2028, inflation cap 2038, World ID fee design and Q3 2025 pilot (accessed 2026-09-22)
- https://whitepaper.world.org/advancing-decentralization: Foundation treasury, WLD as fee token, decentralization stages (accessed 2026-09-22)
- https://api.llama.fi/summary/fees/world-chain?dataType=dailyFees: World Chain fees, monthly series (accessed 2026-09-22)
- https://api.coingecko.com/api/v3/coins/worldcoin-wld: supply and market data (accessed 2026-09-22)
