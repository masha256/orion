# Ethena (ENA)

Researched 2026-09-22. Rank #13 by market cap (layer-1 tokens, stablecoins and tokenized RWAs excluded). Market cap $2.1B, FDV $3.2B, price $0.211 (CoinGecko, 2026-09-22).
Chain(s): Ethereum (ERC-20 `0x57e114b691db790c35207b2e685d4a43181e6061`), bridged via LayerZero. CoinGecko id: `ethena`. DefiLlama slug: `ethena` (parent) / `ethena-usde` (fees, revenue); no holders-revenue series.

## Verdict

Orion fit: C. USDe earns real gross revenue (about $175-237M a year), but none of it reaches ENA today. A fee switch was voted through on 2026-09-08, but it only turns on when USDe supply reaches $7.5B. Supply is $4.89B today.

## Business and revenue

- USDe is a synthetic dollar. Its backing earns funding and basis on delta-neutral hedges, lending yield (Aave, Morpho, Kamino, Jupiter, institutional loans), RWA yield (BUIDL, JAAA, STAC) and rewards on liquid stablecoins (docs.ethena.fi/backing-assets/protocol-revenue).
- Who receives it: nearly all of it goes to sUSDe stakers, partner payouts and Aave liquid-leverage rewards. Blockworks Advisory's fee-switch analysis (2026-08-27) found that over the last 30 days $175M a year was distributed: 34.3% to sUSDe, 34.3% to partner payouts, 31.4% to Aave liquid leverage. Mint fees add about $8.4M a year (4.7% of gross). The Reserve Fund has received no allocation recently and holds about $62M (LlamaRisk June 2026 update).
- DefiLlama `ethena-usde` (fetched 2026-09-22):
  - Fees: 30d $19.46M (about $237M annualized); 1y $275.6M.
  - "Revenue", meaning the Reserve Fund share: 30d $14.7k; 1y $3.18M.
- Trend: gross fees fell from about $55M a month (Aug 2025) to about $16M a month (Aug-Sep 2026), because USDe supply dropped from about $15B at its 2025 peak to about $4.1B (Aug 2026). Supply has since recovered to $4.89B (DefiLlama stablecoins, 2026-09-22). sUSDe APY was about 3.8% in June 2026.
- Company layer: Ethena Labs develops the protocol, and the Ethena Foundation holds the treasury. Under the approved design, net revenue from each business line (USDe savings, whitelabel stablecoins, Ethena [X]) "is paid to the Ethena Foundation". StablecoinX (Nasdaq: USDE) is a listed ENA treasury company.

## Holder flows

- `ena_fee_switch_buyback`: kind burn or buy_and_hold (mechanics unconfirmed: the proposal says "ENA buybacks" tracked on a dashboard; burn is not specified); capture_rule programmatic (a take rate that steps with USDe supply, approved by governance vote); recipient_base all.
  - Trailing annualized: $0. At today's $4.89B supply the schedule takes nothing.
  - Schedule (gov.ethenafoundation.com/t/830, vote passed 2026-09-08, snapshot 0xcb6b9e...): the take on gross protocol revenue is 5% at $7.5B USDe, 10% at $10B, 15% at $15B and 20% at $20B. Blockworks recommends measuring supply as a 14-day average.
  - Blockworks backtest (705 days): it would capture $52.7M a year while active, but only $8.82M a year averaged over the whole cycle. That is about a tenth of scheduled gross unlocks ($512M a year to April 2028).
  - History: the Nov 2024 fee-switch proposal had gates (USDe > $6B, cumulative revenue > $250M, listing on CEX derivatives venues) that were never enforced. The 2026 schedule replaces them.
- `foundation_buyback_2025` (not a holder flow): in Sep-Oct 2025 the Foundation ran a $310M ENA buyback over 6-8 weeks, funded by StablecoinX PIPE cash rather than revenue (gov.ethenafoundation.com/t/704). Under Orion's rules this is a capital-markets transaction, not revenue-funded, so it is excluded.
- sENA staking: distributions to sENA are discretionary, and "as of September 2025 no distributions are in effect or announced" (docs, How to Stake ENA).

Capture rate today: $0 / about $237M gross fees (DefiLlama 30d annualized) = 0%.

## Supply

- Max/total supply 15.0B. Circulating 10.10B (CoinGecko 2026-09-22). No burns, so effective supply = total.
- supply_basis: `circulating` plus the unlock schedule. Vesting is heavy and runs to about April 2028, so total supply overstates what trades today, but unlocks are certain.
- Unlocks (DefiLlama emissions dataset, Ethena CSV):
  - Next 12 months: about 3.20B (team 1.12B, investors 0.94B, ecosystem 0.66B, foundation 0.49B).
  - Next 24 months: about 4.92B.
  - Team and investor vesting: 1-year 25% cliff from 2024-03-05, then 3 years linear monthly.
- Emissions: no protocol inflation. sENA yield is zero (no distributions). Staked ratio unknown.

## Data availability for Orion

| metric | source type | endpoint / contract / slug | notes |
|---|---|---|---|
| price, circ supply | coingecko | `ethena` | |
| gross fees | defillama | `ethena-usde` dailyFees | "Revenue" series is only the Reserve Fund share; do not use it as revenue |
| USDe supply (fee-switch trigger) | http_json | `https://stablecoins.llama.fi/stablecoins` (id 146) | drives the take-rate step |
| holder flow | none yet | Ethena transparency dashboard (app.ethena.fi) once live | buyback address not published yet; EVM (Ethereum), so transfer_flow is likely feasible once known |
| unlocks | http_json / manual | `https://defillama-datasets.llama.fi/emissions/ethena` | |

An EVM RPC can read ENA supply. There is no flow to read yet.

## Orion mapping

- Modules:
  - forward_multiple on revenue at about 50% weight, labeled market convention on gross USDe revenue.
  - holder_cashflow at about 50%, with a conditional flow: take rate = f(USDe supply) per the approved step schedule. A new driver `usde_supply` with scenario paths would be needed.
- holder_flows: one entry, `ena_fee_switch_buyback`, programmatic, all. Today's amount is 0. Scenario-dependent activation (bear: never reaches $7.5B; base: 5-10% take from 2027; bull: 15%+).
- Assumptions needed: USDe supply path, gross yield (about 4-6%), take-rate steps, net unlock dilution of about 3.2B/yr.
- Open questions: whether bought ENA is burned or held; the buyback address; whether the Foundation's "net revenue" differs from gross.

## Sources

- https://api.llama.fi/summary/fees/ethena-usde?dataType=dailyFees / dailyRevenue: fees, revenue, methodology (2026-09-22)
- https://stablecoins.llama.fi/stablecoins: USDe circulating $4.89B (2026-09-22)
- https://gov.ethenafoundation.com/t/830.json: "ENA Fee Switch Activation" proposal, Blockworks/OAK/Kairos analyses, vote passed 2026-09-08 (2026-09-22)
- https://gov.ethenafoundation.com/t/808.json: June 2026 governance update, Reserve Fund, USDe supply, APY (2026-09-22)
- https://gov.ethenafoundation.com/t/704.json: Sept 2025 update, $310M Foundation buyback funded by StablecoinX (2026-09-22)
- https://docs.ethena.fi/overview/ena.md, /overview/ena/tokenomics.md, /backing-assets/protocol-revenue.md: token role, vesting, revenue sources (2026-09-22)
- https://docs.ethena.fi/overview/ena.md?ask=... (GitBook ask): sENA distributions discretionary, none as of Sept 2025 (2026-09-22)
- https://defillama-datasets.llama.fi/emissions/ethena: unlock schedule (2026-09-22)
- https://api.coingecko.com/api/v3/coins/markets?ids=ethena: supply (2026-09-22)
