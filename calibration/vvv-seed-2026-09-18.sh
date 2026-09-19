#!/usr/bin/env bash
# Hand-entered VVV observations as of 2026-09-18, from the research pass recorded in the design spec (section 4).
# Run from the repo root after "npm run build". Safe to re-run: same metric + same timestamp supersedes.
set -euo pipefail
O="node dist/cli/index.js"
D="research pass 2026-09-18"

$O data set vvv price_usd 27.46 --at 2026-09-18 --detail "$D: CoinGecko and Venice API"
$O data set vvv effective_supply 81003579 --at 2026-09-18 --detail "$D: totalSupply minus balanceOf(0x0)"
$O data set vvv circulating_supply 48350000 --at 2026-09-18 --detail "$D: Venice API vvv_stats"
$O data set vvv staked_supply 33964988 --at 2026-09-18 --detail "$D: staking totalSupply()"
$O data set vvv locked_supply 8969695 --at 2026-09-18 --detail "$D: totalLockedStakedVVV()"
$O data set vvv staker_emission_share 0.947 --at 2026-09-18 --detail "$D: Venice API vvv_staking_yield (6488 of 6850 per day)"

# Emission schedule: --at is the effective date. The 2026-10-01 cut is announced, not yet on-chain.
$O data set vvv emission_rate_annual 2500000 --at 2026-09-01 --detail "$D: EmissionRateUpdated event"
$O data set vvv emission_rate_annual 2000000 --at 2026-10-01 --detail "$D: Venice blog update of 2026-08-05 (announced)"

# Revenue-funded burns in USD. --at is the END of the period, --period-days its length.
$O data set vvv flow_usd.burn 241800 --at 2026-07-01 --period-days 30 --detail "$D: vvv_burn_history 2026-06"
$O data set vvv flow_usd.burn 445200 --at 2026-08-01 --period-days 31 --detail "$D: vvv_burn_history 2026-07"
$O data set vvv flow_usd.burn 702700 --at 2026-09-01 --period-days 31 --detail "$D: vvv_burn_history 2026-08"
$O data set vvv flow_usd.burn 676500 --at 2026-09-18 --period-days 17 --detail "$D: vvv_burn_history 2026-09 month to date"

$O data set vvv diem_supply 37759.6 --at 2026-09-18 --detail "$D: DIEM totalSupply()"
$O data set vvv diem_target_supply 40000 --at 2026-09-14 --detail "$D: on-chain mint-rate table after the 2026-09-14 update"
$O data set vvv diem_price_usd 2057.69 --at 2026-09-18 --detail "$D: CoinGecko id diem"
$O data set vvv diem_locked_yield_share 0.8 --at 2026-09-18 --detail "$D: veniceEmissionsPercentageWhenLocked() = 20 percent"

# Revenue is a secondhand disclosure, so it goes in as provisional with its citation.
$O data set vvv revenue_run_rate_usd 100000000 --at 2026-08-17 --provisional \
  --citation "https://coincodex.com/article/90258/vvv-spikes-20-as-venice-ai-tops-100m-annualized-revenue/" \
  --quote "Venice just crossed \$100m annualized revenue" \
  --detail "$D: founder post on X, read via press quote"
