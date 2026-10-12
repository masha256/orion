# CAKE onboarding (2026-10-12)

Branch `feat/cake`. Asset `assets/cake.yaml`; chain BNB Chain (56) via `ORION_BNB_RPC_URL` (Alchemy, same app key as Ethereum).

## What was built

- **BNB Chain** in `src/ingest/transport/chains.ts` (+ viem `bsc`): 0.45s blocks (measured over 1M blocks), 50,000-block log
  range (Alchemy served 200k with `blockTimestamp`), no keyless default (12 public endpoints tried: none served both ranged
  logs and archive reads).
- **`cake.emission_rate_annual`** adapter: MasterChef v2 `cakePerBlock(true) + cakePerBlock(false)` (farm shares only) ×
  blocks a year measured from the chain (last 1M blocks), so a block-time hard fork can't silently mis-scale it.
- **`ignore_below_tokens`** on `transfer_flow`: transfers below N tokens from strangers are dust (address poisoning), never
  counted or reported. Listed senders are counted whatever their size.
- Persona paragraph (onchain-dex-analyst): read the burn at the converters, not at dead.

## The burn, read on chain (100 days to 2026-10-12)

- dead receives ~99% minted-and-reburned CAKE: MasterChef v1 mints 40 CAKE/block → v2, which returns 99.7168% to the burner
  `0xceba…4a0e`; the dev share (10% of each mint) is minted straight to the burner. The burner sends everything to dead weekly
  (Mondays). An unfiltered scan of dead overstates the holder flow ~100x.
- Holder flow = CAKE into the burner from the fee converters (`0x518d…`, `0x0ed9…`, `0x75a9…`; owner `0x2183…`) and small
  product routes (`0x5f17…`, `0x0130…`, `0x292c…`). Converters send ~73% to the burner, ~27% to the treasury `0x5ebc…ac84`.
- Unlisted senders into the burner over 365 days: 1 dust (6e-6 CAKE from a dead lookalike), and 5 transfers in 2025-10..12
  (`0x9f1f…`, `0xfa20…`, `0xecc9…`) totalling ~158k CAKE, outside the 100-day backfill. If one recurs it raises
  `unlisted_sender`.

## Numbers (scratch home, real fetch, report day 2026-10-11)

- Price $2.30; mcap $731.3M; FDV $771.6M; total supply 335.47M (totalSupply − dead; CoinGecko 329.54M nets 5.93M locked in
  legacy pools, 1.77% gap, tolerance 2.5%).
- Burn $57.08M/yr (91d) = 28.72M CAKE/yr; 7.40% buyback yield; 13.5x holder flow.
- Emissions 7.93M CAKE/yr (farms); net supply −20.79M/yr (−6.20%).
- Revenue (burn + treasury) $77.75M; payout 73.4%. DefiLlama revenue $67.0M (90d), holders revenue $45.2M: DefiLlama
  computes burns from swap volume × fee shares, Orion observes them.
- Gross fees (DefiLlama) $203.45M/yr.

## Verification

- 860 tests green, typecheck clean. New tests fail with their change stashed (chain table, dust rule, adapter).
- The other 8 assets: old vs new build at the same as-of on a copy of live, byte-identical engine output.
- Live dry fetch and real fetch in a scratch home: every source ok, no anomalies.

## Open (checkpoints)

1. Persona assign + live fetch. 2. First tick (bootstrap journal). 3. Calibration packages (Mike picks).
4. First signal. 5. Cron at 05:45 PT (`orion-cake`, wrapper `orion-tick-cake.sh`).
