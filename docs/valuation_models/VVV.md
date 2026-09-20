# VVV valuation model

How Orion values the Venice Token (VVV), component by component, with a worked example.

The numbers are a snapshot: signal `vvv-20260920T150211Z-4` (run 4, engine 1.2.0, assumption set version 2), spot $28.91, 12-month expected target $35.05. The structure is stable; the numbers move daily. Live values: `orion signal latest vvv --json`.

Where things live:

| What | Source of truth | Notes |
|---|---|---|
| Structure: modules, weights, bounds, metrics, scenario probabilities | `assets/vvv.yaml` | Read from disk on every run; its hash is recorded with each signal (`config_hash`). |
| Assumption values | the database (`assumption_sets`, newest version) | `calibration/vvv-assumptions.yaml` is an import file, not what the engine reads. See section 2. |
| Observations and drivers | the database (`observations`) | |
| The math | `src/engine/` | |
| Design intent | `docs/superpowers/specs/2026-09-18-orion-valuation-framework-design.md` | |

## The question the model answers

What should one VVV be worth at a horizon (6 or 12 months out)? The model answers that three different ways under three scenarios, blends the answers, adds a small DIEM term, and probability-weights the scenarios.

```
observations ─► drivers ─► for each scenario (bear / base / bull):
                              supply forecast ◄─┐ (iterate until the price settles)
                              3 estimate modules ─► weighted blend ─┤
                              + DIEM component ─────────────────────┘
                           ─► probability-weight the 3 scenario targets ─► signal
```

## 1. Drivers (measured facts)

`src/drivers/compute.ts` turns observations into inputs. Values on 2026-09-20:

| Driver | Value | Source |
|---|---|---|
| Spot price | $28.91 | CoinGecko |
| Revenue run rate | $100M | manual entry, disclosed 2026-08-17 |
| Effective supply | 81.01M VVV | on-chain, total minus burned |
| Emissions | 2.5M/yr now, 2.0M/yr from 2026-10-01 | on-chain, plus the announced cut entered as a schedule row |
| Burn flow, trailing 90 days annualized | $7.44M/yr | on-chain transfers to the zero address from the two allowlisted senders |
| Capture rate today | 7.44% | derived: burn ÷ revenue |

The capture rate is the share of Venice's revenue that reaches token holders, which for VVV means burns. It links the company's revenue to the token's value.

## 2. Assumptions (views, per scenario)

### Where assumption values come from

The engine reads the newest assumption set in the database (`getLatestAssumptionSet` in `src/app/valuation.ts`). It never opens `calibration/vvv-assumptions.yaml`. That file is the record of the last hand calibration and the input to an import:

- **Import:** `orion model assumptions import vvv calibration/vvv-assumptions.yaml --rationale "..."` validates the file against the keys and bounds in `assets/vvv.yaml`, then writes a new versioned set (author, rationale, parent version). Editing the YAML has no effect until it is imported again.
- **Direct change:** `orion model assumptions set vvv <key> <value>` writes a new database version and does not touch the YAML, so the file can fall out of date. The planned agent will write versions the same way.
- **What is in force:** `orion model assumptions show vvv`. Version history: `orion model assumptions history vvv`.
- **Replay:** each run records its assumption set id, so `orion model replay <run_id>` reproduces a past signal with the assumptions it used, whatever the file says now.

On the server, the server's `orion.db` holds the assumptions in force.

### The paths built from them

The values quoted in this document are assumption set version 2, which matches `calibration/vvv-assumptions.yaml` as imported on 2026-09-19. Two paths are built from them in `src/engine/paths.ts`:

- **Revenue path.** Year-1 growth fades linearly to terminal growth over `growth_fade_years`. In the base case growth runs +100%, then 75.75%, 51.5%, 27.25%, then 3%.
- **Capture path.** Capture ramps linearly from today's measured rate to `capture_rate_terminal.burn` (15% in base) over `capture_ramp_years.burn` (3 years).

Holder flow in any year is revenue multiplied by capture for that year.

The four views that drive the target:

| View | Bear | Base | Bull |
|---|---|---|---|
| Year-1 revenue growth | +25% | +100% | +200% |
| FDV-to-forward-revenue multiple | 6 | 11 | 16 |
| Terminal capture rate | 4% | 15% | 35% |
| Regime multiplier (market mood) | 0.6 | 1.0 | 1.3 |

Everything else moves the 12-month target by well under $1 across its plausible range.

### Data versus assumptions

| | Today's value (data) | Future path (assumption) |
|---|---|---|
| Revenue | `revenue_run_rate_usd`, entered by hand or agent-researched with a citation | `rev_growth_y1`, `growth_fade_years`, `terminal_growth` |
| Capture | burn ÷ revenue, recomputed daily from chain | `capture_rate_terminal.burn`, `capture_ramp_years.burn` |

Capture today is never a judgement. Only the future-path assumptions are, and each change to them is a new versioned assumption set with an author and a rationale. Under the planned agent (sub-project 3, spec section 7) an in-bounds change must also cite observation ids as evidence, an out-of-bounds change becomes a proposal, and module weights, scenario probabilities and bounds are proposal-only. The agent never writes a target.

## 3. Supply forecast (`src/engine/supply.ts`)

Every module divides a dollar value by the supply at the horizon:

> supply at horizon = supply now + emissions − tokens burned

Tokens burned each month are the burn dollars divided by the price, along a straight line from spot to the target. This creates a circularity: the target depends on supply and supply depends on the target. `src/engine/run.ts` loops until the target moves by less than 0.1% (3 iterations in run 4).

Base case at 12 months: 81.01M + 2.01M emitted − 0.56M burned = **82.47M**.

## 4. The three estimate modules

**`fm_revenue` (weight 0.4): what the market would pay for the business.**
Value is forward revenue × multiple × regime multiplier ÷ supply. "Forward" means revenue at the horizon plus half a year. This is market convention: FDV is quoted against company revenue even though holders don't receive that revenue.

**`fm_holder_flow` (weight 0.3): the same calculation on what holders actually get.**
It uses forward burn dollars and a higher multiple (30x in base), closer to an earnings multiple than a sales multiple.

**`hc` (weight 0.3): a discounted cash flow of the burns, per token.**
Five explicit years after the horizon plus a Gordon terminal value.

- Each year's burn dollars are divided by that year's supply, so emissions after the horizon dilute the claim.
- The discount rate is `discount_rate_base` plus `discount_premium_discretionary`, because the burns are discretionary and Venice could stop them. Base: 15% + 6% = 21%.
- Burns do not also shrink supply after the horizon, which would count them twice (spec section 8 amendment).

Weights are the user's "balanced" calibration of 2026-09-19: the market prices VVV mostly on company revenue today, so the revenue multiple gets the largest single weight, but 60% still rests on cash flows that reach holders.

## 5. DIEM component (`src/engine/modules/utilityClaim.ts`)

An unweighted add-on, not an estimate. It values future DIEM issuance only, since existing DIEM is value already handed to its minters. For each new DIEM, the value is its market price minus the cost of locking the VVV needed to mint it (the staking yield given up), discounted and divided by supply. About $0.31 in base, so nearly immaterial.

## 6. Blending and the signal

- Scenario target = 0.3·`hc` + 0.4·`fm_revenue` + 0.3·`fm_holder_flow` + DIEM.
- Expected target = 0.25·bear + 0.5·base + 0.25·bull.
- Staked total return compounds the staking yield on top of the price change. The DIEM-locked variant scales the yield by `diem_locked_yield_share` (0.8).
- Dispersion is (max − min module value) ÷ blended value: how much the three methods disagree.
- Data quality separately produces the grade and status.

## Worked example: base case, 12 months (run 4)

**Shared paths**

- Forward revenue at 1.5 years: $100M × 2.0 × √1.7575 = **$265.1M**.
- Capture at 1.5 years: 7.44% + (15% − 7.44%) × 1.5/3 = **11.22%**.
- Forward burn flow: $265.1M × 11.22% = **$29.75M**.

**`fm_revenue`:** $265.1M × 11 × 1.0 = $2.917B; ÷ 82.47M = **$35.36**

**`fm_holder_flow`:** $29.75M × 30 × 1.0 = $892M; ÷ 82.47M = **$10.82**

**`hc`, discounted at 21%.** Flows and supply are taken at mid-year.

| Year after horizon | Revenue | Capture | Burn $ | Supply | $ per token | PV |
|---|---|---|---|---|---|---|
| 1 | $265M | 11.2% | $29.7M | 83.5M | 0.356 | 0.295 |
| 2 | $433M | 13.7% | $59.4M | 85.5M | 0.696 | 0.475 |
| 3 | $601M | 15% | $90.1M | 87.5M | 1.030 | 0.581 |
| 4 | $688M | 15% | $103.2M | 89.5M | 1.153 | 0.538 |
| 5 | $708M | 15% | $106.2M | 91.5M | 1.162 | 0.448 |

- The explicit years sum to a PV of **$2.34**.
- Terminal growth per token is 3% revenue growth less 2.2% dilution (2.0M emitted on 92.5M supply): (1.03 ÷ 1.0216) − 1 = 0.82%.
- Terminal value is 1.162 × 1.0082 ÷ (0.21 − 0.0082) ÷ 1.21⁵ = **$2.24**.
- Total: **$4.57**.

**DIEM**

- Mint cost is 464 VVV per DIEM: 90 × exp(2 × fill³) with fill = 37,436 ÷ 40,000 = 0.936.
- Locking cost is 464 × 5.5% staking yield × 20% Venice take × $19.08 × 2.99 (5-year annuity at 20%) = $292.
- Net value is $2,068 − $292 = $1,776 per DIEM.
- About 25,100 DIEM are issued over 5 years at 10% target-supply growth.
- PV is $25.8M; ÷ 82.47M = **$0.31**.

**Blend:** 0.3 × 4.57 + 0.4 × 35.36 + 0.3 × 10.82 + 0.31 = 1.37 + 14.15 + 3.25 + 0.31 = **$19.08**

**Across scenarios**

| | `hc` | `fm_revenue` | `fm_holder_flow` | DIEM | Target | × probability |
|---|---|---|---|---|---|---|
| Bear | 0.30 | 5.97 | 0.85 | 0 | **$2.73** | 0.68 |
| Base | 4.57 | 35.36 | 10.82 | 0.31 | **$19.08** | 9.54 |
| Bull | 86.86 | 121.87 | 80.82 | 0.27 | **$99.32** | 24.83 |

- Expected target = **$35.05**, 21.2% above spot.
- Staked total return is (35.05 ÷ 28.91) × 1.0551 − 1 = **+27.9%**; DIEM-locked, +26.6%.

## What the example shows

- **The bull scenario carries the signal.** The base case of $19 is below spot, and $24.83 of the $35.05 expected value comes from the 25%-probability bull. This was known and accepted at calibration; it is the most important point when reading a VVV signal.
- **In the base case the revenue multiple dominates.** It contributes $14.15 of $19.08 (74%). The two holder-flow methods say the burns alone justify only $5 to $11. The market prices VVV on company revenue, not on what reaches holders.
- **The bull case is the only one where the methods converge.** Dispersion is 0.41 in bull against 1.64 in base, because 35% capture on $300M+ revenue makes the burns large enough to matter.
- **Four assumptions drive almost everything:** growth, the revenue multiple, terminal capture, and regime. The $100M revenue figure scales every module linearly, which is why the advisory stale-revenue anomaly matters more than its label suggests.

To see how the target responds to an assumption without saving anything: `orion model whatif vvv`.
