# UNUS SED LEO (LEO)

Researched 2026-09-22. Rank #5 by market cap (layer-1 tokens, stablecoins and tokenized RWAs excluded). Market cap $8.3B, FDV $8.8B, price $8.97 (CoinGecko, 2026-09-22).
Chain(s): EOS (issuer account `bitfinexleo1`, where the burns happen) and Ethereum (ERC-20 `0x2af5d2ad76741191d15dfe7bf6ac92d4bd912ca3`, 660M supply, unchanged over the last year). CoinGecko id: `leo-token`. DefiLlama slug: none (no Bitfinex or iFinex entry in the fees overview).

## Verdict

Orion fit: B. A rule-based buyback-and-burn (at least 27% of iFinex consolidated gross revenue, monthly) is observable day by day on EOS, at about $30M a year. But iFinex publishes no revenue, the chain is not EVM, and the rule is a company commitment.

## Business and revenue

iFinex runs Bitfinex, a centralized exchange (trading, margin lending and derivatives fees). The company keeps its revenue and publishes no financials. The LEO white paper (2019) commits iFinex to buy back LEO each month with at least 27% of the prior month's consolidated gross revenue, and to burn the tokens it buys (Coinpedia, 2026-07-31, repeats the rule).

Implied revenue: trailing burn of about $29.7M / 0.27 = about $110M a year of iFinex gross revenue. Because the rule says "at least 27%", this is an upper bound. It looks low for Bitfinex. Either the "consolidated gross revenue" base is defined narrowly, or some buybacks are not burned on EOS. Both are unconfirmed. Trend: about $6.8-7.4M per quarter (Q4 2025 to Q2 2026), flat in USD.

Separate one-off: the 2019 white paper also commits iFinex to use 80% of net funds recovered from the 2016 Bitfinex hack and the Crypto Capital loss to buy back and burn LEO within 18 months. The 80% figure is from memory, unconfirmed. A March 2026 court ruling ordered hacked BTC returned to Bitfinex (headlines from Crypto News, 2026-03-10, and CoinMarketCap, 2026-03-11; details unconfirmed). The EOS burn series shows no large spike through 2026-09-01, so no recovery-funded burn has happened yet.

## Holder flows

- id `leo_revenue_buyback_burn`, kind burn, capture_rule discretionary (a written company commitment with no enforcement; call it contractual only if the white paper is treated as binding), recipient_base all.
  - Observed: near-daily EOS transfers from `bitfinexdep1` to the issuer `bitfinexleo1` with memo `burn`. That is 3,356 such actions since September 2024 (Hyperion `eos.hyperion.eosrio.io/v2/history/get_actions?account=bitfinexleo1&filter=bitfinexleo1:transfer`).
  - Trailing 12 months (September 2025 to August 2026): 3,177,689 LEO burned, about $29.7M at monthly average prices.
  - Per quarter: Q4 2025 about $7.44M (804.6k LEO); Q1 2026 about $6.85M (781.8k LEO); Q2 2026 about $6.84M (687.5k LEO). July 2026: $1.92M; August 2026: $2.03M.
  - History: in effect since 2019. No change in 2025-2026. The possible hack-recovery burn is a pending one-off.

Capture rate today: $29.7M burn / about $110M implied gross revenue, which is 27% by construction. The true denominator is unknown.

## Supply

Initially 1B LEO (EOS plus Ethereum), with no minting. On-chain now: EOS supply 307,653,658.9 (get_currency_stats, 2026-09-22) plus Ethereum 660,000,000 (totalSupply). CoinGecko: total 985.24M, circulating 919.86M. The cumulative burn of about 79.9M (Coinpedia, 2026-07-31) matches the circulating figure. Emissions: none. No staking, no unlocks. supply_basis: circulating (about 920M) is the total supply. The CoinGecko total appears not to net out all burns. The burn shrinks supply by about 0.35% a year.

## Data availability for Orion

| metric | source type | endpoint / contract / slug | notes |
|---|---|---|---|
| price, supply | coingecko | `leo-token` | |
| burn (tokens) | http_json | Hyperion get_actions on `bitfinexleo1`, memo `burn` (paginate) | non-EVM; an adapter or http_json with aggregation is needed |
| EOS supply | http_json | `POST https://eos.greymass.com/v1/chain/get_currency_stats {"code":"bitfinexleo1","symbol":"LEO"}` | the supply delta equals the burn |
| revenue | manual | none published | implied from the 27% rule |

An EVM RPC cannot read the flow: the Ethereum-side supply is static and the burns are on EOS.

## Orion mapping

- Modules: holder_cashflow 0.5, forward_multiple on holder_flow 0.3, forward_multiple on revenue 0.2 (implied revenue, market convention).
- holder_flows: `leo_revenue_buyback_burn` {burn, discretionary, all, trailing ≈ $29.7M/yr}. Optionally, a bull-scenario one-off for the hack-recovery burn.
- Assumptions needed: iFinex revenue growth; the capture stays at 27% (the "at least" allows more); the probability and size of the recovery burn.
- Obstacles: EOS data path (the delta of get_currency_stats is the simplest source); no revenue disclosure. Market cap is about 280 times the annual burn, so the valuation is dominated by the recovery optionality or by non-cash-flow demand.

## Sources

- https://api.coingecko.com/api/v3/coins/markets?ids=leo-token and /coins/leo-token/market_chart?days=365 (price, supply, monthly prices; 2026-09-22)
- https://eos.hyperion.eosrio.io/v2/history/get_actions?account=bitfinexleo1 (burn transfers; 2026-09-22)
- https://eos.greymass.com/v1/chain/get_currency_stats (EOS LEO supply; 2026-09-22)
- https://eth.drpc.org JSON-RPC (ERC-20 totalSupply, flat at 660M; 2026-09-23)
- https://coinpedia.org/news/why-is-unus-sed-leo-a-top-11-crypto-that-almost-nobody-talks-about/ (27% rule, about 79.9M burned; 2026-09-22)
- Google News RSS headlines: "Court-ordered BTC return to Bitfinex…" (Crypto News, 2026-03-10), "LEO Holds $9.13-$9.23 After Bitfinex Ruling" (CoinMarketCap, 2026-03-11) (recovery context, articles not opened; 2026-09-22)
