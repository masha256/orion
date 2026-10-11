# UNI onboarding: follow-ups

Date: 2026-10-11. Spec: `docs/superpowers/specs/2026-10-11-orion-uni-onboarding-design.md`.

## Checkpoints

1. Done 2026-10-11. `persona assign uni onchain-dex-analyst`; `data fetch uni --dry-run`: every source ok, no anomaly, nothing
   written (8,603 observations before and after).
2. Done 2026-10-11. `./run-daily.sh uni` (about 2 minutes): observations 8,603 → 8,922. Signal `uni-20261011T095742Z-74`,
   blocked only on `no_assumption_set`, at grade A, stamped today. The Chainlink price check was 0.20% off CoinGecko.
   Bootstrap journal flags, answered:
   - "The holder flow is dated 2026-07-13": the trailing-window value is stamped at its oldest day, as for CRV and HYPE;
     not staleness.
   - "Burn 17.2M UNI/yr against a 20M vest": wrong; it divided dollars by today's price. Measured in tokens the burn is
     23.6M/yr. That led to the report's token supply line (`reporting.burned_tokens`).
   - "September surge: new chains or price?": mostly price. Tokens burned: July 1.13M (28 days), August 2.00M,
     September 2.54M. October 1–10: 0.38M (~14M/yr), below the vest; watch it.
3. Done 2026-10-11. Central package on the 91-day window (table below); agent bands by the mirror rule.
4. Done 2026-10-11. `model run uni`: `uni-20261011T121814Z-75`, ok, grade A. 12m expected 5.86 (bear 0.72 / base 3.31 /
   bull 16.11, dispersion 0.93; hc 3.68, fm_holder_flow 9.14). 6m expected 4.95. Inbox empty.
5. The cron line `orion-uni`, 00:40 UTC (17:40 PDT): see below.

## Calibration (2026-10-11, spot 7.56, 91-day run rate $131.7M, market at about 51x it)

| Package | 12m expected | vs spot | bear / base / bull | dispersion |
|---|---|---|---|---|
| conservative | 3.06 | −60% | 0.36 / 2.04 / 7.80 | 1.12 |
| **central (picked)** | **5.86** | **−22%** | 0.72 / 3.31 / 16.11 | 0.93 |
| constructive | 11.98 | +58% | 1.16 / 5.77 / 35.22 | 0.61 |

- Spot needs a 59x holder-flow multiple in every scenario, or +75% first-year burn growth.
- Sweep on base: revenue growth (−9 / +11%) and the multiple (−7 / +13%) drive the value; discount, fade and terminal are
  each under 3%; staked_ratio_horizon is 0 (no staking).

## Report (live, day 2026-10-10)

- Burn yield 1.96%; Labs vest dilution 2.25%. The net shareholder yield in USD is −0.29%.
- In tokens: burned 23.58M/yr against 20.00M added, so net −3.58M/yr (−0.40%: supply shrinks). The USD figure is negative
  only because the burn is valued at each day's price and the vest at spot.
- Gross swap fees $1.71B/yr (DefiLlama, display only).

## Open

- The October burn pace (~14M UNI/yr) is below the vest. If it holds through the next window, net token supply grows.
- The Arc fee-expansion temp check and the burn-to-staking RFC (quiet since 2026-07-10). A pass on chain changes the
  flow's senders (Arc: picked up automatically by `from_any`) or its kind (staking: a rebuild).
- The Labs vest's approval ends after four more quarters (2027-10). Renewal needs a vote; the cap line drops to 0
  without one.
