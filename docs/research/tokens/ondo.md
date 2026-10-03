# Ondo (ONDO)

Researched 2026-09-22. Rank #14 by market cap (layer-1 tokens, stablecoins and tokenized RWAs excluded). Market cap $2.1B, FDV $4.4B, price $0.436 (CoinGecko, 2026-09-22).
Chain(s): Ethereum (ERC-20 `0xfaba6f8e4a5e8ab82f62fe7c39859fa577269be3`), bridged. CoinGecko id: `ondo-finance`. DefiLlama slug: `ondo-finance` (parent) / `ondo-yield-assets`.

## Verdict

Orion fit: D. ONDO is a governance token for the Ondo DAO/Flux ecosystem. It has no fee switch, buyback or revenue share. The revenue-earning business is Ondo Finance (a company plus BVI issuers), and it does not publish revenue. DefiLlama shows $0 protocol revenue.

## Business and revenue

- Ondo Finance issues tokenized RWAs:
  - USDY: tokenized T-bill note; DefiLlama says it charges no fee.
  - OUSG: its 0.15% fee is waived until 2027 (DefiLlama methodology).
  - Ondo Global Markets / Ondo Stocks: tokenized equities. Ondo keeps the quote spread and fees ("any difference and any fees being retained by Ondo Stocks", docs.ondo.finance/ondo-stocks/fees-and-taxes).
  - Flux Finance: a lending protocol governed by ONDO.
- DefiLlama `ondo-yield-assets` (2026-09-22):
  - Fees: 30d $7.66M; 1y $62.3M. This is the yield passed through to USDY/OUSG holders, not Ondo income.
  - Revenue: 30d $0.
  - Methodology: "Revenue: Zero. Ondo passes all of this yield to token holders and currently charges no fee".
- DefiLlama's parent `ondo-finance` shows "holders revenue" of $4.38M over 1y ($3.7M Sep 2025, $3.2M Oct 2025, $0 since Nov 2025). That is a legacy classification of USDY/OUSG product yield as "holders" (holders of USDY, not ONDO). It is not an ONDO flow.
- Company layer: Ondo Finance Inc. and its issuer entities keep the spread and any fees. The Ondo Foundation supports the ONDO ecosystem. No published revenue figures (unknown).

## Holder flows

none. No fee switch, buyback or staking yield for ONDO was found in the docs (docs.ondo.finance lists no ONDO revenue mechanism). DefiLlama shows no ONDO-holder revenue. Searched: docs llms.txt index; there is no governance forum reachable over Discourse JSON.

Capture rate today: $0 / $0 published protocol revenue = not defined. Company revenue is unknown.

## Supply

- Total/max 10.0B. Circulating 4.87B (CoinGecko 2026-09-22). No burns.
- supply_basis: `circulating` plus unlocks (the large annual cliffs matter).
- Unlocks (DefiLlama emissions dataset): annual cliffs every January 17. Each one releases about 1.71B ONDO: Ecosystem Growth 792M, Protocol Development 660M, Private Sales 258M.
  - Next: 2027-01-17 (1.71B, about 35% of circulating). Then 2028-01-17 (1.71B).
  - Next 12 months: 1.71B; next 24 months: 3.42B.
- No emissions or staking yield.

## Data availability for Orion

| metric | source type | endpoint / contract / slug | notes |
|---|---|---|---|
| price, supply | coingecko | `ondo-finance` | |
| product yield (not revenue) | defillama | `ondo-yield-assets` dailyFees | Revenue = 0 |
| company revenue | manual | none published | tokenized-stock spread income is off-chain |
| unlocks | http_json | `https://defillama-datasets.llama.fi/emissions/ondo-finance` | |

An EVM RPC can read supply. There is no flow to read.

## Orion mapping

- No holder_cashflow is possible. A valuation would be a forward_multiple on an assumed company revenue, which is unpublished, and the token has no claim on it. The fee waiver ends in 2027, but OUSG fees would accrue to the issuer, not ONDO.
- Recommendation: not suitable. Revisit if an ONDO fee switch or buyback is announced.

## Sources

- https://api.llama.fi/summary/fees/ondo-finance and /ondo-yield-assets (dailyFees, dailyRevenue, dailyHoldersRevenue): methodology and totals (2026-09-22)
- https://docs.ondo.finance/llms.txt and /ondo-stocks/fees-and-taxes.md: products, retained spread (2026-09-22)
- https://defillama-datasets.llama.fi/emissions/ondo-finance: unlock cliffs (2026-09-22)
- https://api.coingecko.com/api/v3/coins/markets?ids=ondo-finance: supply (2026-09-22)
