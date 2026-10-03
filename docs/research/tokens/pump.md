# Pump.fun (PUMP)

Researched 2026-09-22. Rank #15 by market cap (layer-1 tokens, stablecoins and tokenized RWAs excluded). Market cap $2.1B, FDV $3.8B, price $0.00451 (CoinGecko, 2026-09-22).
Chain(s): Solana (mint `pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn`). CoinGecko id: `pump-fun`. DefiLlama slug: `pump` (parent; children `pump.fun`, `pumpswap`, `terminal`, `pump.fun-mobile-app`).

## Verdict

Orion fit: B. The revenue is large and published, and the buyback-and-burn is large, on-chain and tracked on DefiLlama as holders revenue. But the share is set by the company, which changed it from 100% of the pump slice to 50% in April 2026. The company also keeps the rest. The data path is config-only through DefiLlama.

## Business and revenue

- Fees:
  - Bonding-curve trade fee: pump slice 0.95%, plus 0.30% for the creator or cashback slot, since 2025-09-15.
  - Graduation fees and Mayhem-mode fees.
  - PumpSwap AMM: 0.05% protocol, 0.20% LPs, 0.05% creators.
  - Terminal (Padre) and the mobile app.
- Payers and recipients: traders pay. Pump.fun (the company) receives the protocol slice, and creators and LPs receive their slices (DefiLlama adapter pumpdotfun.ts header).
- DefiLlama `pump` parent (2026-09-22):
  - Revenue: 30d $52.6M (about $640M annualized); 1y $454.6M.
  - Fees: 30d $155.9M; 1y $1.11B.
- Monthly revenue: $45-55M (Aug-Sep 2025), $27-48M (2026). The last full months were Jul 2026 $33.7M and Aug 2026 $58.1M. The trend is flat to slightly down, with a spike in August.
- Company layer: Pump.fun is a company. It keeps the non-buyback share (now 50% of the pump slice, plus 100% of graduation and Mayhem fees).

## Holder flows

- `pump_buyback_burn`: kind burn; capture_rule discretionary (company policy, not a contract); recipient_base all.
  - Trailing annualized: $286M from 30d ($23.49M × 12.17); 1y $280.8M.
  - Source: DefiLlama `pump` dailyHoldersRevenue, "PUMP token buyback (sourced from onchain burns; aggregates buybacks across all pump products)".
  - Observability: PUMP burns from wallets `99mRw3EzdJZWEUjgp1nrU4WeHsukUBjbh7gYE7pm4F3c` and `9jHrTCwpDANHLNQz5cem6XLUBM8KiTWKe766Br6KVCXM` (DefiLlama adapter, via Allium `solana.assets.transfers` type burn). Both wallets had over 1,000 transactions on 2026-09-22/23 (Solana RPC getSignaturesForAddress), so buybacks are daily.
  - PUMP total supply is 832.47B, down from 1T at TGE (Solana RPC getTokenSupply, 2026-09-22). That means about 167.5B PUMP (16.75%) has been destroyed. That is more than the cumulative $363M of buybacks alone would imply at typical prices, so part of it may be a burn of previously held buybacks or other allocations (unconfirmed).
  - Daily amounts: $0.4-1.3M a day in late Aug-Sep 2026.
  - History (DefiLlama adapter constants):
    - Buyback started 2025-07-14 with 100% of the pump slice.
    - "Burn policy" from 2026-04-28: the buyback share dropped to 50% and bought tokens are burned.
    - Monthly holder flow fell from about $25-32M (Jan-Apr 2026) to $12-16M (May-Jul 2026), then $27.1M in Aug 2026.
    - fees.pump.fun/api/buybacks, the old buyback API, now returns the SPA HTML and is no longer usable.

Capture rate today: 30d holders revenue $23.5M / 30d revenue $52.6M = 45%. 1y: $280.8M / $454.6M = 62% (before the April 2026 cut it was about 100% of the pump slice).

## Supply

- Max 1T. Total (net of burns) 832.47B = effective. Circulating 467.0B (CoinGecko 2026-09-22).
- supply_basis: `effective_total` minus the locked team/investor tranches, or `circulating` with the unlock schedule. Circulating is recommended, given the large insider unlocks.
- Unlocks (DefiLlama emissions dataset):
  - Team (200B) and existing investors (130B) cliff-unlocked 25% on 2026-07-12 (89.4B), then about 6.875B a month (team 4.17B + investors 2.71B) for 36 months.
  - Next 12 months: 82.5B (about 18% of circulating; about $360M at today's price).
  - Next 24 months: 165B.
  - The Community & Ecosystem 24% allocation is marked TBD: partly undistributed in Squads vaults as of July 2026.
- No emissions or staking yield.

## Data availability for Orion

| metric | source type | endpoint / contract / slug | notes |
|---|---|---|---|
| revenue | defillama | `pump` dailyRevenue | parent aggregates all products |
| holder flow (burns) | defillama | `pump` dailyHoldersRevenue | sourced from on-chain burns |
| supply (burn cross-check) | adapter or http_json (POST) | Solana JSON-RPC `getTokenSupply` on the PUMP mint at `https://api.mainnet-beta.solana.com` | non-EVM; a Solana adapter is needed to observe burns directly |
| price, circ | coingecko | `pump-fun` | |
| unlocks | http_json | `https://defillama-datasets.llama.fi/emissions/pump` | |

No EVM RPC applies (Solana).

## Orion mapping

- Modules: holder_cashflow 50% on `pump_buyback_burn` (burn, discretionary, all); forward_multiple on holder_flow 25%; forward_multiple on revenue 25%, labeled market convention (company revenue).
- Assumptions needed:
  - Revenue growth. Memecoin launchpad activity is cyclical; bear case should decay by 30-50%.
  - Terminal capture: base 45%, reflecting the current 50% of the pump slice. Bear 20-30%, since the company has cut the share once already.
  - Discount for discretionary capture.
  - Unlock dilution of about 82.5B a year through mid-2029.
- Obstacles: the capture rule is discretionary; the history of held versus burned tokens is unclear; the equity layer keeps half.

## Sources

- https://api.llama.fi/summary/fees/pump (dailyFees, dailyRevenue, dailyHoldersRevenue): totals, monthly series, methodology (2026-09-22)
- https://raw.githubusercontent.com/DefiLlama/dimension-adapters/master/fees/pumpdotfun.ts: fee history, buyback eras (2025-07-14 100%, 2026-04-28 50%), burn wallets (2026-09-22)
- https://api.mainnet-beta.solana.com getTokenSupply (PUMP mint) and getSignaturesForAddress (burn wallets): supply 832.47B, daily activity (2026-09-22)
- https://defillama-datasets.llama.fi/emissions/pump: unlock schedule and TBD note (2026-09-22)
- https://api.coingecko.com/api/v3/coins/markets?ids=pump-fun: supply (2026-09-22)
- https://fees.pump.fun/api/buybacks: tried, returns HTML now (2026-09-22)
