# Quant (QNT)

Researched 2026-09-22. Rank #29 by market cap (layer-1 tokens, stablecoins and tokenized RWAs excluded). Market cap $1.07B, FDV $1.08B, price $73.69 (CoinGecko, 2026-09-22).
Chain(s): Ethereum (ERC-20 `0x4a220e6096b25eadb88358cb44068a3248254675`). CoinGecko id: `quant-network`. DefiLlama slug: none.

## Verdict

Orion fit: C. Quant Network Ltd, a UK private company, earns real, audited revenue (£11.5M in the year to 30 Sep 2025). That revenue stays with the company: no burn, buyback or fee share reaches QNT holders, and the 2025 accounts do not mention the token. A valuation could only apply a market-convention revenue multiple to company revenue, labeled as such.

- A: revenue-funded holder flow exists, is measurable (on-chain or DefiLlama), and revenue is published. Config-only or near config-only in Orion.
- B: real revenue and a holder flow exist but something is hard: off-chain data, discretionary capture, non-EVM chain needing an adapter, or an equity layer that keeps most value.
- C: revenue exists but nothing reaches holders today (fee switch off, all to validators/treasury), or the flow is inflation-funded; a valuation would rest entirely on an assumed future capture.
- D: no revenue model (store of value, meme, pure inflation staking). Not suitable.

## Business and revenue

Quant sells the Overledger platform (an API gateway for banks, central banks and enterprises to access multiple DLTs; tokenisation and interoperability) on a subscription/licence model. Quant Network Ltd (Companies House 09798383) full accounts for the year ended 30 Sep 2025, filed 2026-07-06: revenue £11,515,582 (FY2024 £10,704,062, +7.6%), gross margin 84.8%, operating profit £1,794,454, profit before tax £1,923,715, cash £7,867,037, headcount 44. That is about $15M at roughly 1.33 USD/GBP (conversion approximate). The strategic report names concentration in a small number of clients and does not mention QNT, token treasury or crypto-assets. Revenue is updated once a year, 9 months after year end.

Token usage: historically Quant said Overledger licence fees are paid in fiat and converted by the "Quant Treasury" into QNT locked for 12 months, which creates buy demand but no transfer to holders (unconfirmed: quant.network returned 403 and the 2025 accounts are silent on it). Even if the mechanism operates, the tokens return to the company after the lock, so it is not a holder flow by Orion's definition.

## Holder flows

none. No burn, no buyback program, no staking or fee share. The 12-month treasury lock, if still operated, is at most temporary token demand controlled by the company (discretionary, unobservable).

Capture rate today: 0 / £11.5M = 0%.

## Supply

Fixed supply 14,612,493 QNT (CoinGecko total = max; historically reduced from 46.5M by a 2018 burn of unsold tokens, per earlier project statements, unconfirmed). Circulating 14,544,176 (99.5%); FDV ≈ mcap. No emissions, no staking yield, no scheduled unlocks. A large share is believed to be held by the company/treasury (unknown size). supply_basis: `effective_total` (≈ circulating).

## Data availability for Orion

| metric | source type | endpoint / contract / slug | notes |
|---|---|---|---|
| price, mcap, circ | coingecko | `quant-network` | |
| revenue | manual | Companies House accounts, company 09798383 | annual, GBP, lag about 9 months |
| holder flow | none | n/a | |
| supply | erc20_supply | Ethereum `0x4a22...4675` | fixed |

No on-chain flow to read.

## Orion mapping

- Modules: `forward_multiple` on revenue (market convention, company revenue, explicitly not a holder claim), weight 1.0. `holder_cashflow` = 0.
- Assumptions: revenue growth 5-15%; revenue multiple on a small private software company; bull could assume a token capture that does not exist today, clearly marked.
- Obstacles: token and equity are separate claims; the company keeps everything; only annual revenue data.

## Sources

- https://api.coingecko.com/api/v3/coins/quant-network (supply, description; 2026-09-22)
- https://find-and-update.company-information.service.gov.uk/company/09798383/filing-history (filings list; 2026-09-22)
- Quant Network Ltd full accounts to 30 Sep 2025, filing document MzUyOTUwOTAxNGFkaXF6a2N4 (income statement p.11, strategic report pp.2-3; 2026-09-22)
- https://quant.network/qnt-token/ (403, could not confirm the treasury mechanism; 2026-09-22)
