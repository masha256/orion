# WhiteBIT Coin (WBT)

Researched 2026-09-22. Rank #2 by market cap (layer-1 tokens, stablecoins and tokenized RWAs excluded). Market cap $10.3B, FDV $25.4B, price $86.61 (CoinGecko, 2026-09-22).
Chain(s): Ethereum (ERC-20 `0x925206b8a707096ed26ae47c84747fe0bb734f59`, 8 decimals), Tron (TRC-20 `TFptbWaARrWTX5Yvy3gNG5Lm8BmhPx82Bt`), native gas token of Whitechain (PoA L1, moving to an OP Stack Ethereum L2, mainnet targeted fall 2026). CoinGecko id: `whitebit`. DefiLlama slug: none (no WhiteBIT or Whitechain entry in the fees overview, 2026-09-22).

## Verdict

Orion fit: B. A large, steady burn is visible on Ethereum (the ERC-20 total supply falls every week, about $200M a year), and the stated rule ties it to exchange fees. But WhiteBIT publishes no revenue, the rule is a company commitment, and the burn may be split across three chains.

## Business and revenue

WhiteBIT is a centralized exchange (W Group; the page cited below claims 40M+ users across the group). Traders pay trading fees and the company keeps them. WhiteBIT is a private company and publishes no revenue or profit (searched 2026-09-22; none found). Whitechain gas fees are paid in WBT and are small. No DefiLlama figure exists.

Implied revenue: the stated rule burns 33% of trading fees plus 5% of other exchange revenue. A trailing burn of about $200M a year therefore implies about $600M a year of trading fee revenue, if the whole burn comes from trading fees. This is derived, not published. Trend: the burn fell in tokens from about 470k WBT a month (Q4 2025) to about 200-270k a month (mid-2026). In USD it fell from about $24M a month to about $13-15M a month, then rose with the price in September 2026.

## Holder flows

- id `wbt_fee_burn`, kind burn, capture_rule discretionary (a published company commitment, not enforced by any contract), recipient_base all.
  - Rule (CoinGecko project description, 2026-09-22): weekly burns funded by 33% of trading fees and 5% of other exchange revenues, until 50% of the 400M max supply has been destroyed. So the target supply is 200M. An August 2026 article repeats the 33% / 5% split and the 200M target.
  - Trailing annualized: 3,654,504 WBT removed from the Ethereum ERC-20 total supply between 2025-09-22 and 2026-09-21. That is 169.11M down to 165.42M, read by `totalSupply()` at archive blocks via eth.drpc.org. Valued at monthly average CoinGecko prices, that is about $199.7M. Last three months: about $43.5M, or about $174M annualized. In a 14-day log sample, the burns were `Transfer` events to 0x0 from `0xd77d461d51d356569ee281795afd5eb62e2e8f0c`, with no mints. That supports reading the supply decline as burns, not bridge movements (the sample was incomplete because of RPC errors).
  - Caveat: burns may also happen on Tron and Whitechain. If so, the Ethereum series is a lower bound. WhiteBIT's own burn tally is not reachable (whitebit.com returns 403 to fetchers).
  - History: an initial 25M WBT burn at launch (2022). The weekly burn program is ongoing, and 2026 articles do not report any change.
- id `wbt_souldrop` (minor): the SoulDrop gives WB Soul holders (minimum 10 WBT) a pro-rata share of Whitechain transaction fees every 30 days (Kraken blog). kind fee_share, discretionary, recipient_base locked. Its size is negligible and unknown.

Capture rate today: about $200M burn / about $600M implied revenue, so about 33% by construction. Measured against total company revenue (unknown) it is lower. The numerator is observed on-chain, but the denominator is only implied by the rule.

## Supply

Max 400M. CoinGecko total 293.42M (so about 106.6M burned, including the initial 25M), circulating 118.85M (2026-09-22). Kraken's April 2026 blog put circulating at about 214M in early 2026. The gap is large and unexplained: CoinGecko may be excluding WhiteBIT-held or holding-program balances. Ethereum ERC-20 supply is 165.42M (2026-09-23). No emissions. The Funds 2 tranche (200M) unlocked over three years from August 2022. The full unlock completed in 2026, per the August 2026 article. There is no staking inflation: the exchange "holding" program gives fee discounts, not minted tokens. supply_basis: effective_total (293.4M) is the conservative choice, because the circulating figure is disputed. The ratio of FDV to market cap is 2.5x.

## Data availability for Orion

| metric | source type | endpoint / contract / slug | notes |
|---|---|---|---|
| price, supply | coingecko | `whitebit` | circulating figure disputed |
| burn (tokens) | erc20_supply | Ethereum `0x925206b8…4f59` totalSupply delta | EVM RPC can read it; the Tron and Whitechain parts are not covered |
| burn (USD) | derived | token delta × price | |
| revenue | manual | none published | implied from the 33% rule only |
| Whitechain gas | adapter | Whitechain RPC (EVM) | tiny |

An EVM RPC can read the main flow (the Ethereum totalSupply decline).

## Orion mapping

- Modules: holder_cashflow 0.5 (burn flow, discretionary), forward_multiple on holder_flow 0.3, forward_multiple on revenue 0.2 (implied revenue, labeled market convention).
- holder_flows: `wbt_fee_burn` {burn, discretionary, all, trailing ≈ $200M/yr from erc20_supply}.
- Assumptions needed: revenue growth tied to exchange volume; the burn stops at 200M supply (about 93M WBT still to burn, which is more than 20 years at the current token pace, so it does not bind within the horizon); a haircut for discretionary capture.
- Obstacles: no published revenue; possible burns on Tron and Whitechain; the circulating-supply discrepancy; the Whitechain L2 migration in fall 2026 may change where native WBT is burned.

## Sources

- https://api.coingecko.com/api/v3/coins/markets?ids=whitebit (price, supplies; 2026-09-22)
- https://api.coingecko.com/api/v3/coins/whitebit (project description with burn rule, contracts; 2026-09-22)
- https://api.coingecko.com/api/v3/coins/whitebit/market_chart?days=365 (monthly average prices; 2026-09-22)
- https://eth.drpc.org and https://ethereum.publicnode.com JSON-RPC (ERC-20 totalSupply history, Transfer logs; 2026-09-23)
- https://blog.kraken.com/token-spotlight/what-is-whitebit-coin-wbt (distribution, SoulDrop, holder benefits; 2026-09-22)
- https://blockchainreporter.net/wbt-sets-new-all-time-high-as-whitechain-and-w-group-ecosystem-advance/ (33% / 5% rule, 200M target, L2 shift; 2026-09-22)
- https://api.llama.fi/overview/fees (no WhiteBIT or Whitechain slug; 2026-09-22)
