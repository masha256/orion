# Orion: category dominance as an input to the assumptions (design, 2026-10-17)

Status: draft for Mike's review. Nothing built yet.

## Why

Mike (2026-10-17): large "total value" metrics (TVL, TVS) measure usefulness and network effects, and that should show up
in the forward price targets. Two tests set the scope:

1. **Short-run growth: rejected.** A spike (DefiLlama daily TVL vs fees, 9 assets, walk-forward quarterly forecasts)
   found that adding TVL growth or the fees/TVL ratio made forecasts *worse* than fee mean-reversion alone. UNI +20%, CRV
   +20 to +25%, CAKE +1 to +7%, AERO +3 to +4% error. Only SKY improved (−6 to −12%). TVL moves with fees at the same time,
   mostly through token price; it does not lead them. So TVL does **not** drive `rev_growth_y1`.
2. **Long-run durability: kept, as judgment, not as a formula.** A dominant protocol keeps its earnings advantage
   longer. That maps onto `growth_fade_years`, `terminal_growth` and, a little, `discount_rate_base`. There is no evidence
   for a coefficient (how many fade years 10 points of share are worth), so dominance sets *where in the band* a pick
   sits, with the share written down as the reason. No `f(dominance)` in the engine.

## How much the lever is worth (scratch whatif, 2026-10-17 21:00Z, live copy)

"D1 dominance tilt": in each scenario, set `terminal_growth` to the band max and `discount_rate_base` to the band min,
and add 2 years to `growth_fade_years`. Bands and everything else unchanged. 6-month expected target:

| Asset | Spot | Live E | D1 E | Gap to spot closed |
|---|---|---|---|---|
| LINK | 12.05 | 0.606 (−95.0%) | 0.720 (−94.0%) | 1.0% |
| UNI | 7.21 | 4.928 (−31.7%) | 5.954 (−17.4%) | 45% |

Durability can't rescue LINK. Even at the hard limits (fade 10 y, terminal 5%, discount 8% in every scenario) LINK's
expected target is 1.21 (−90%), and with bull flow growth in every scenario on top of that, 2.17 (−82%). LINK's gap is
the size of the flow and dilution, not how long the flow lasts. UNI is where this lever matters: a dominant player with
a big flow, so durability moves the target a lot. That's why it has to stay inside the bands and be cited.

## Part 1: a dominance input per asset

Store dominance as `monitor_only` level metrics, so it is never a driver, never in the grade and can't move a value by
itself. The analyst sees it in its context pack.

- `dominance_share` (ratio): the protocol's share of its category over the last 30 days.
- `dominance_share_1y` (ratio): the same share over the last year. The trend is `dominance_share` minus this.

Category and measure per asset (DefiLlama `overview/fees` and `overview/dexs`, free endpoints, grouped by
`parentProtocol`). Today's values:

| Asset | Category, measure | 30 d | 1 y | Rank | Trend |
|---|---|---|---|---|---|
| UNI | DEX volume (global) | 31.2% | 23.1% | 1 | rising |
| CAKE | DEX volume (BSC) | 70.0% | 67.6% | 1 on BSC | flat/up |
| AERO | DEX volume (Base) | 50.1% | 47.1% | 1 on Base | rising |
| CRV | DEX volume (global) | 1.1% | 2.3% | 16 | falling |
| HYPE | perp fees | 44.8% | 45.7% | 1 | flat |
| LIT | perp fees | 3.1% | 4.2% | 4 | falling |
| PUMP | launchpad fees | 30.6% | 39.6% | 1 | falling |
| SKY | CDP fees | 93.7% | 91.6% | 1 | flat |
| LINK | oracle value secured | ~60–63% | n/a | 1 | manual |

Notes:
- **DEXes use volume share, not TVL share.** Emissions can buy TVL (AERO, CAKE). Volume is harder to fake. Fee share is
  shown alongside it for reference.
- **The perp derivatives volume endpoint is paywalled (402)**, so HYPE and LIT use fee share from the free fees overview.
- **LINK: DefiLlama's oracle (TVS) endpoint is paywalled.** Its fee "Oracle" category is meaningless: Chainlink's fee
  figure there is tiny next to geodnet's. So `dominance_share` for LINK has no source and is recorded by research
  (quarterly, with a citation; DefiLlama-derived figures in press: 60.3–63.1% on 2026-10). It is the asset's only manual
  metric.
- **Not covered:** VVV (no meaningful category), and yCRV, cvxCRV and sdCRV (wrappers; they take CRV's).

Build:
- A new source type `defillama_share`: `{ parent, category, overview: fees|dexs, chain?, window: 30d|1y }`. It returns
  the parent's sum divided by the category sum. It needs the same fields as the existing `defillama` source, plus a
  sanity check: refuse if the category total is 0 or the parent isn't found, rather than writing 0.
- Every asset that gets the metric moves its config hash, so its next signal lists "config". No engine change, no
  ENGINE_VERSION bump, and the VVV golden test is untouched (VVV gets no metric).
- **A failed read marks the source failed and counts toward the failure streak** (the existing `monitor_only`
  behaviour). That's a new outside dependency for 8 assets, though on DefiLlama, which most already use.
- History starts the day it goes live. The overview endpoints return current totals only, with no backfill path.

## Part 2: the calibration rule

Write this into each sector persona (dex, perp, launchpad, stablecoin, oracle) and the calibration notes:

> Dominance and its trend decide where inside the band `growth_fade_years`, `terminal_growth` and `discount_rate_base`
> sit. A leading and rising share points to the bull-side edge; a falling share points to the bear-side edge, *even
> when the share is still high*. Cite the `dominance_share` observation in every rationale that uses it. Dominance never
> justifies a change to `rev_growth_y1` or the multiple (the 2026-10-17 spike: TVL and share don't predict next-quarter
> growth). Without a dominance observation, leave those three keys where they are.

The agent's existing guardrails (allowed range per run, cited observations, proposals for anything outside the band)
are unchanged.

## Choices for Mike

1. **AERO and CAKE: chain-local or global share?** Recommend chain-local (Base 50%, BSC 70%). Their moats are their
   home chains. Globally they are 6% and 10%, which understates how locked-in their position is.
2. **LINK: manual quarterly TVS share vs. a DefiLlama Pro key (about $300/month)** for an automated source. Recommend
   manual: it changes slowly, and the lever is worth about 1% of LINK's gap.
3. **Rollout: all 8 assets at once, or UNI first** (where the lever matters most), then the rest after a week of clean
   reads. Recommend all at once: same source, and the risk is in the source, not per asset.

## Testing

- `defillama_share`: unit tests on a fixture of the overview JSON (grouping by parent, category filter, chain filter,
  refusal on a missing parent or zero total).
- Asset tests: every asset still validates, every value is unchanged against its latest live signal (`model whatif
  --json`, before → after for all 13: monitor-only metrics must not move a number), and the new hashes are re-pinned.
- A scratch-home live fetch for all 8 assets, compared against the numbers in this spec.
