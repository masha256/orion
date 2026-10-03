# Bitget Token (BGB)

Researched 2026-09-22. Rank #24 by market cap (layer-1 tokens, stablecoins and tokenized RWAs excluded). Market cap $1.5B, FDV $1.9B, price $2.11 (CoinGecko, 2026-09-22).
Chain(s): Ethereum (ERC-20 `0x54D2252757e1672EEaD234D27B1270728fF90581`; the burns are visible at 0x…dEaD), and the gas and governance token of Morph (an L2) since September 2025. CoinGecko id: `bitget-token`. DefiLlama slug: none for Bitget. Only `bitget-sol`, its liquid staking, is listed.

## Verdict

Orion fit: C. BGB burns are measurable on Ethereum, but they are no longer tied to Bitget's revenue or profit. The rule moved first to a gas-usage formula (April 2025) and then to burns by the Morph Foundation linked to Morph activity (September 2025). Since then the quarterly burns have been a flat, round ~3M BGB, which reads as treasury burns rather than revenue-funded ones.

## Business and revenue

Bitget, a private exchange, earns trading fees and keeps them. It publishes no revenue or profit. There is no DefiLlama figure. Rule history:
- December 2024 to January 2025: 800M team-held BGB were burned (40% of supply). The rule announced then was a quarterly burn funded by a share of Bitget's profit. The prompt says 20% of profit; that figure was not verified in a primary source here.
- April 2025 (Bitget blog): the quarterly burn is "linked to the amount of BGB used for on-chain gas fees" through Bitget Wallet GetGas. The formula uses gas usage, the quarterly average price and constants. Q1 2025 burn: 30,006,905 BGB (about $130M).
- July 2025: Q2 2025 burn of 30M BGB (about $138M, GlobeNewswire headline, 2025-07-10).
- 2025-09-02 (Bitget announcement): Bitget transferred 440M BGB to the Morph Foundation. 220M were burned (on-chain 2025-09-07). The other 220M are released at 2% a month. The quarterly rule is replaced by burns tied to Morph network activity, "until the total BGB supply is reduced to 100 million".

The implied revenue cannot be computed, because the current burn is not a percentage of revenue or profit.

## Holder flows

- id `bgb_morph_burn`, kind burn, capture_rule discretionary, recipient_base all.
  - On-chain burns to 0x…dEaD on Ethereum (archive balanceOf): 2026-01-26 +3,060,425 BGB (about $11.0M at the January average of $3.60); 2026-04-11 +3,000,330 (about $5.8M at $1.92); 2026-07-16 +3,010,400 (about $5.0M at $1.66). No quarterly burn appeared in October 2025.
  - Trailing 12 months: 9.07M BGB, about $21.8M. Latest quarter: about $5.0M, or about $20M annualized.
  - The funding source of these burns is unclear. They may come from Morph Foundation or Bitget treasury tokens rather than open-market buybacks, in which case they are not revenue-funded at all.
- Earlier, now-ended flows: the profit-share burn (announced December 2024) and the gas-formula burns (Q1 and Q2 2025, 30M each).

Capture rate today: about $20M a year / Bitget revenue (unpublished). It is not rule-linked, so it is best treated as unknown and small.

## Supply

Max 2B. Burned at 0x…dEaD: 1,089,079,125 BGB (2026-09-23). CoinGecko total is 910.92M (it matches 2B minus the burn) and circulating is 699.99M. Scheduled release: the 220M Morph allocation at 2% a month, which is 4.4M a month or 52.8M a year until exhausted (about 2029-2030). This release roughly doubles the circulating increase compared with the burn. Staking: none that is fee-funded. supply_basis: effective_total (910.9M). The ratio of FDV to market cap is 1.3x.

## Data availability for Orion

| metric | source type | endpoint / contract / slug | notes |
|---|---|---|---|
| price, supply | coingecko | `bitget-token` | |
| burn (tokens) | contract_read | Ethereum balanceOf(0x…dEaD) on `0x54D2…0581` | EVM; deltas give the burn |
| burn (USD) | derived | delta × price | |
| Morph release | manual / contract_read | Morph Foundation wallet (address not identified) | |
| revenue | manual | none published | |

An EVM RPC can read the burn.

## Orion mapping

- Modules: forward_multiple on revenue (labeled, on an estimate of Bitget revenue) 0.6; holder_cashflow 0.4 on the observed burn with a heavy haircut.
- holder_flows: `bgb_morph_burn` {burn, discretionary, all, trailing ≈ $22M/yr}.
- Obstacles: the burns are decoupled from revenue; the source of the burned tokens is unclear; the Morph release schedule dilutes; Bitget has changed the rule three times in nine months.

## Sources

- https://www.bitget.com/blog/articles/bitget-bgb-burn-update-2025 (April 2025 gas-linked rule, Q1 2025 burn; 2026-09-22)
- https://www.bitget.com/support/articles/12560603836781 (September 2025 Morph transfer, 220M burn, 2% monthly release, burn to 100M; 2026-09-22)
- Google News RSS headlines: "Bitget Burns 30M BGB Worth $138 Million for Q2 2025" (GlobeNewswire, 2025-07-10); "Bitget Burns $130M in BGB" (Bitget, 2025-04-17) (headlines; 2026-09-22)
- https://eth.drpc.org JSON-RPC (dead-address balance history; 2026-09-23)
- https://api.coingecko.com/api/v3/coins/markets?ids=bitget-token and market_chart?days=365 (supply, prices; 2026-09-22)
