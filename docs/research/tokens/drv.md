# Derive (DRV)

Researched 2026-09-22. Rank #50 by market cap (layer-1 tokens, stablecoins and tokenized RWAs excluded). Market cap $0.43B, FDV $0.64B, price $0.429 (CoinGecko, 2026-09-22).
Chain(s): Ethereum (ERC-20 `0xb1d1eae60eea9525032a6dcb4c1ce336a1de71be`), with OFT deployments on Base, Arbitrum, Optimism and HyperEVM. The protocol runs on Derive Chain (OP stack), which is migrating to Derive V3 (a zkVM settling on Ethereum; DIP 2026-09-14). Formerly Lyra (LYRA to LDX to DRV). CoinGecko id: `derive`. DefiLlama slug: `lyra` parent does not resolve; use children `derive-options`, `derive-v2`.

## Verdict

Orion fit: B. The DAO has allocated 35% of protocol fees to DRV buybacks since April 2026 (25% before that). But the buybacks are executed off-chain by a BVI subsidiary and held in its treasury, not burned (the burn proposal was not adopted). DefiLlama shows $0 holders revenue. Revenue is small: about $4-6M a year against a $0.43B market cap.

## Business and revenue

- Derive is an on-chain options (about 95% of on-chain options premium volume, per DIP 322), perps and spot venue.
- Fees:
  - Perps: taker $0.01 + 0.03%, maker 0.01%.
  - Options: taker $0.5 + min(0.03% notional, 12.5% premium).
  - RFQ discounts, 10% liquidation fees, and a USDC borrow spread (docs, trading-fees).
- Recipients: fees accrue to the Security Module (insurance fund) and treasury. Gas fees on Derive Chain go to the DAO.
- DefiLlama (2026-09-22):
  - `derive-options` revenue: 30d $0.425M, 1y $3.09M.
  - `derive-v2` revenue: 30d $0.069M, 1y $0.91M.
  - Total: 30d about $0.49M (about $6.0M annualized); 1y about $4.0M.
  - Monthly revenue rose from about $0.1-0.2M (late 2025) to $0.3-0.5M (Mar-Sep 2026).
- Company layer: the Derive Foundation and its Derive Subsidiary (BVI) Ltd have held protocol parameters and treasury assets since DIP 309 (Jan 2026), including 2.47M USDC of fees scoped for "DRV buybacks" and operations. DIP 303 says "there is no value accruing equity associated with any" Derive entity.

## Holder flows

- `drv_buyback`: kind buy_and_hold (bought DRV is held in the BVI multisig and scoped for incentives and reward programs); capture_rule discretionary (the percentage is set by DAO vote; execution and use are at the BVI subsidiary's discretion); recipient_base all.
  - Trailing annualized: about $2.1M, estimated as 35% × $6.0M, not observed. DefiLlama `derive-*` dailyHoldersRevenue is $0 (not tracked).
  - History:
    - DRV launch (DIP 233, 2024): 25% of revenue to buybacks for the DAO treasury.
    - May 2025: a DIP to raise it to 80% (outcome unknown; the Apr 2026 DIP says the prior share was 25%, so it likely did not pass).
    - Sep 2025: the burn-policy DIP was opposed by a delegate ("premature ... while we continue issuing 500,000 DRV tokens weekly") and has no recorded passage.
    - 2026-04-01 (DIP 313): buyback share raised to 35%; staking emissions cut from 250k to 100k DRV a week from 2026-04-22.
  - Observability: unknown. Buybacks may run on Derive Chain or a CEX; no public buyback address was found. The Derive Chain explorer is an EVM (OP stack), so transfer_flow could work if the address were known. Derive Chain is being wound down for V3.

Capture rate today: about 35% of fees by DAO rule (unobserved). DefiLlama: 0 / $6.0M.

## Supply

- Total/max 1.5B after DIP 303 (Sep 2025): a 500M strategic mint to the Foundation, a 50% supply increase, vesting over about 4 years with at most 8.25% dilution a year. Circulating 999.7M (CoinGecko). No burns.
- supply_basis: `circulating` plus the strategic-mint vesting schedule.
- Emissions:
  - Staking: 100k DRV a week (about 5.2M a year, about 0.5% of circulating) since 2026-04-22. This is inflation-funded, about 1.5% APR to stakers; not value.
  - Trading rewards: additional, amount unknown. There were 500k a week total emissions in Sep 2025.
- Unlocks: strategic-mint tranches (25% vested at passage, the rest quarterly over 12 months for strategic allocations; core-contributor tranches vest longer). Not in the DefiLlama emissions dataset. The exact 12-24 month figure is unknown.

## Data availability for Orion

| metric | source type | endpoint / contract / slug | notes |
|---|---|---|---|
| revenue | defillama | `derive-options` + `derive-v2` dailyRevenue | DefiLlama sources it from `stats-api.derive.xyz/fees` |
| revenue cross-check | http_json | `https://stats-api.derive.xyz/fees` (per the DefiLlama methodology) | public JSON |
| holder flow | manual | forum DIPs, BVI treasury registry | no address published |
| price, supply | coingecko / erc20_supply | `derive`; Ethereum contract | |

An EVM RPC can read DRV supply. The buyback flow is not readable today (address unknown).

## Orion mapping

- Modules: forward_multiple on revenue 50%, labeled market convention. holder_cashflow 50%, with `drv_buyback` (buy_and_hold, discretionary, all) at a 35% capture assumption.
- Assumptions: revenue growth (options TAM, V3 launch), the capture rate (35%, possibly lower in practice), dilution from the strategic mint (up to 8.25% a year) plus staking emissions.
- Obstacles: no observed flow; buybacks are held and can fund incentives, which works like re-emission; the revenue is small relative to the valuation.

## Sources

- https://docs.derive.xyz/integrators/trading/trading-fees.md: fee schedule (2026-09-22)
- https://forums.derive.xyz/t/313.json: DIP, buybacks 25% to 35%, staking 250k to 100k/week (2026-04-01) (2026-09-22)
- https://forums.derive.xyz/t/304.json: burn-policy DIP and delegate objection (2025-09) (2026-09-22)
- https://forums.derive.xyz/t/279.json: 80% buyback DIP (2025-05) (2026-09-22)
- https://forums.derive.xyz/t/309.json: transfer to the BVI subsidiary, treasury scopes (2026-01) (2026-09-22)
- https://forums.derive.xyz/t/303.json: 500M strategic mint (2025-09) (2026-09-22)
- https://forums.derive.xyz/t/322.json: Derive V3 launch DIP, market share (2026-09-14) (2026-09-22)
- https://api.llama.fi/summary/fees/derive-options, /derive-v2 (all dataTypes, methodology) (2026-09-22)
- https://api.coingecko.com/api/v3/coins/derive (description, contracts) and /coins/markets (2026-09-22)
