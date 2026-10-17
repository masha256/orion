# Dominance followups, 2026-10-17

Spec: `docs/superpowers/specs/2026-10-17-orion-dominance-design.md`. Plan: `docs/superpowers/plans/2026-10-17-orion-dominance.md`.

## Measured shares (scratch-home fetch, 2026-10-17 21:29Z)

One `data fetch <a> --metric dominance_share --metric dominance_share_1y` per asset on a copy of the live DB. Every
`defillama_share` source answered ok and wrote one row per metric. Trend = 30 d minus 1 y.

| Asset | Category, measure | 30 d | 1 y | Trend | Spec 30 d | Gap |
|---|---|---|---|---|---|---|
| UNI | DEX volume (global) | 31.2% | 23.1% | +8.1 (rising) | 31.2% | 0.0 |
| CAKE | DEX volume (BSC) | 77.7% | 73.7% | +4.0 (rising) | 70.0% | +7.7, see below |
| AERO | DEX volume (Base) | 50.5% | 47.8% | +2.7 (rising) | 50.1% | +0.4 |
| CRV | DEX volume (global) | 1.1% | 2.3% | −1.1 (falling) | 1.1% | 0.0 |
| HYPE | perp fees | 44.8% | 45.7% | −0.9 (flat) | 44.8% | 0.0 |
| LIT | perp fees | 3.1% | 4.2% | −1.1 (falling) | 3.1% | 0.0 |
| PUMP | launchpad fees | 30.6% | 39.6% | −9.0 (falling) | 30.6% | 0.0 |
| SKY | CDP fees | 93.7% | 91.6% | +2.2 (flat/up) | 93.7% | 0.0 |
| LINK | oracle value secured | manual | n/a | | ~60–63% | not yet recorded |

## CAKE correction

The spec's 70.0% (and 67.6% 1 y) counted every row on DefiLlama's BSC dexs overview. That overview also lists other
categories: Trading App (GMGN), Prediction Market (Predict Fun, OPINION), Launchpad (Flap sh), RWA and others, about 10%
of the BSC total over 30 days. The build counts only category `Dexs` on both sides of the ratio, which is the plan's rule.
Re-measured at 21:29Z from `overview/dexs/BSC`, `parent#pancakeswap`:

| Window | Dexs only (stored) | All categories (spec's basis) |
|---|---|---|
| 30 d | 77.7% | 70.0% |
| 1 y | 73.7% | 67.6% |

So CAKE's trend is rising (+4.0 points), not flat/up. AERO has the same effect, but small: Base's non-Dexs rows are about
1% of the total (Dexs only 50.5% / 47.8%, all categories 50.0% / 47.1%).

## No value moved (13 assets)

Same DB copy, same as-of per asset (its newest `price_usd` observation, 2026-10-17 12:05Z to 13:05Z). `model whatif <a>
--as-of <ts> --json` with `main`'s build (94b853a) and assets, then with this branch's build and assets, before any fetch.
The JSON output was byte for byte the same for all 13. Max difference over the 6 m and 12 m expected targets and all
scenario targets: 0.

| Asset | 12 m expected, main | 12 m expected, branch | Max diff |
|---|---|---|---|
| VVV | 36.23168235 | 36.23168235 | 0 |
| HYPE | 122.7388922 | 122.7388922 | 0 |
| AERO | 0.4574710988 | 0.4574710988 | 0 |
| CRV | 0.03035094703 | 0.03035094703 | 0 |
| yCRV | 0.1232800241 | 0.1232800241 | 0 |
| cvxCRV | 0.06851643575 | 0.06851643575 | 0 |
| sdCRV | 0.1178544993 | 0.1178544993 | 0 |
| UNI | 5.834410738 | 5.834410738 | 0 |
| CAKE | 2.195725904 | 2.195725904 | 0 |
| LIT | 0.374483291 | 0.374483291 | 0 |
| LINK | 0.6675522542 | 0.6675522542 | 0 |
| SKY | 0.07369410653 | 0.07369410653 | 0 |
| PUMP | 0.004588034901 | 0.004588034901 | 0 |

## Context pack

After the fetch, UNI's context pack (`buildContextPack`, no agent call) lists `dominance_share` (0.3124) and
`dominance_share_1y` (0.2313) in `observations_in_force`. LINK's `manual_metrics` lists `dominance_share`.

## Operations

- **History starts on the go-live day.** The overview endpoints give only today's 30 d and 1 y totals, no history, so
  there is no backfill. The trend is 30 d against 1 y until Orion has its own daily rows.
- **8 new DefiLlama dependencies** (one overview read per metric, two per asset). A failed read marks its
  `defillama_share:*` source failed in the fetch report and counts toward the failure streak, but the metrics are
  `monitor_only`, so a failure never moves the grade or the valuation. Test: `tests/ingest/run.test.ts`, "a failed
  defillama_share read marks its source failed but the valuation still runs ungraded-down".
- **LINK is manual, quarterly.** DefiLlama's oracle endpoints are paid (402). Research records the share of oracle total
  value secured with a citation and quote; the oracle persona will treat a value older than 90 days as due.

## Open

- yCRV, cvxCRV and sdCRV don't carry dominance: they are CRV wrappers, and CRV's share is the relevant one.
- VVV has no category to measure against.
- A long-run durability study (does share predict how long earnings last?) would need a sample of 30+ protocols.
