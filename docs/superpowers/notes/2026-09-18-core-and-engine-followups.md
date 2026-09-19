# Sub-project 1 (core and engine): rulings and follow-ups

Carried out of the subagent-driven execution of `docs/superpowers/plans/2026-09-18-orion-core-and-engine.md` on branch `feat/core-and-engine`. The working ledger was scratch; this file is the durable record.

## Rulings the controller made on the user's behalf

Each line: what was decided, why, and what it costs if wrong. Review these and rework any you disagree with.

- Ruling: root .gitignore created by the controller before Task 1 with `.superpowers/` and `.idea/`; Task 1 appends the plan's entries instead of creating the file — the SDD workspace and the user's IDE folder must never be committed — costs nothing if wrong (one file, trivially editable).
- Ruling: work in place on branch feat/core-and-engine, no worktree — user asked for execution and did not ask for a worktree; the final task writes orion.db and calibration files the user will use from this directory — if wrong, the branch can be moved to a worktree at any time with no loss.
- Ruling: Task 15 Step 10 (user calibration checkpoint) is NOT dispatched; the controller presents it to the user at the end — it is a human decision by design — costs nothing if wrong.
- Task 5: Ruling: reviewer finding (plan-mandated) — holderFlows[].annualizedUsd.observedAt uses the NEWEST flow observation while the plan's own rule says derived values take the OLDEST observedAt of their inputs. Plan text contradicts itself (rule vs code listing); the spec is silent. Decided: the rule wins — observedAt = oldest observedAt among the observations actually summed (basis); `newest` stays only for the staleness check. Add a multi-observation test. — keeps one meaning for DriverValue.observedAt across every derived driver — if wrong, cost is one line; nothing in sub-project 1 consumes this field (signal spot uses price.observedAt).
- Task 12: Ruling: reviewer cannot-verify item — DriverReport.manualMetrics/staleMetrics/provisionalMetrics count EVERY metric defined in the asset config that has an observation (including optional/informational ones such as usage_index or an unused extra), while spec section 9 words grades A/B in terms of REQUIRED drivers. Decided: not a fix-loop item; leave as is for sub-project 1 — no shipped config defines an unused metric (VVV's extras are all module-required, usage_index is not defined), and counting everything errs toward a LOWER grade, never a higher one — cost if wrong: a signal graded B instead of A once ingestion lands; revisit in sub-project 2 when on-chain and manual metrics mix. Point the final review at this.
- Task 13: Ruling: fix at the driver layer, not only in replayRun — computeDrivers sorts each metric's observations by (observedAt, id) after grouping, so driver output is independent of caller ordering by contract; plus regression tests at driver and app level — a single enforcement point cannot drift between callers the way two ORDER BY clauses did — cost if wrong: one sort per metric per run (negligible); no stored runs exist yet so no replay compatibility is broken.
- Task 15: Ruling: make the statement true rather than soften it — spec section 10 says "Every command supports --json", and the spec is binding; add an accepted no-op `--json` option to `signal emit` plus a CLI test — a consumer scripting `orion ... --json` uniformly must not get a commander "unknown option" error on one command — cost if wrong: one redundant flag.
- Final: Ruling: F1 overlapping flow periods — detect per flow metric in computeDrivers, return drivers null, block with `overlapping_flow_periods:<metric>`; allow `reject` on any ACTIVE row (confirmed too) so a partial-period row can be retired; constraint wording updated — blocking beats silently picking a winner; rows are still never deleted and replay loads by id — cost if wrong: a user must reject a row before a run proceeds.
- Final: Ruling: F2 trailing flow window ends at the newest reported period end, not at asOf; still divides by windowDays; staleness handles aging — dividing reported data by days that have no report invents zeros, against invariant 5 — cost if wrong: a genuinely stopped flow reads as still running until the staleness limit trips (then the signal degrades).
- Final: Ruling: F3 validateAssetModules runs at the top of runValuation and whatIf; errors become `invalid_config:` blocked reasons — cost if wrong: none (strictly safer).
- Final: Ruling: F4 a provisional insert supersedes only provisional rows; snapshot eligibility drops a provisional row when a confirmed active row exists at the same (metric, observedAt) — confirmed data stays authoritative before the agent exists — cost if wrong: a newer provisional figure at the identical timestamp is ignored until confirmed.
- Final: Ruling: F5 staking-yield denominator = staked_ratio_horizon x EFFECTIVE supply at H (spec 3.6 was ambiguous; staked_ratio is defined on effective supply) — VVV unaffected — cost if wrong: circulating-basis assets' total-return track shifts; price targets do not.
- Final: Ruling: F6 add a VVV golden test pinning sha256 of canonical engine output plus readable assertions; F7 move the validated assumption write to src/app/assumptions.ts; F8 periodDays validation, whatif --as-of guard, breakdown_scenario label, engine_version_mismatch test; F9 bump ENGINE_VERSION to 1.1.0 — stored run 1 in the user's orion.db will then correctly refuse replay; controller re-runs VVV after the wave.

## Notes for the user

- Task 11: note: recipient_base is recorded in the breakdown but has no computational effect anywhere in src/ — this is by spec (section 3.5: aggregate value divided by total forecast supply whatever the base), worth stating to the user.
- Final: methodology note for the user: holder_cashflow divides post-horizon flows by S(H), ignoring dilution after the horizon (faithful to spec 3.5). ~10% optimistic for VVV, large for a 20%-inflation asset like AERO. User decision at calibration.

## Deferred findings (not fixed in sub-project 1)

Minor findings from task reviews and the final review that were triaged as safe to defer. Pick these up in sub-projects 2 and 3 where they touch the same files.

- Task 2: minor (deferred): src/config/load.ts parseAssetYaml lets a YAML syntax error surface as a raw parser error instead of OrionError (matches plan code; CLI top-level handler still prints it).
- Task 4: minor (deferred): buildSchedule `.used` and the same-observedAt id tie-break branches (newer(), schedule sort) have no test.
- Task 4: minor (deferred): trailingFlowAnnualized silently drops a flow observation with periodDays 0 (no NaN, but not flagged as invalid data).
- Task 5: minor (deferred): compute.ts `flowMetricKeys.has(key)` guard in the extra loop is unreachable (schema already forces flow metrics to type flow).
- Task 5: minor (deferred): holder-flow DriverValue is built inline rather than through a derive-style helper (root cause of the finding above).
- Task 6: minor (deferred): paths.ts need() has a redundant `v === undefined` check.
- Task 6: minor (deferred): forecastSupply with horizonYears 0 throws the misleading 'price path must stay positive' (0/0); horizons are fixed at 0.5 and 1 so unreachable today.
- Task 6: minor (deferred): flowUsdAt and yearsBetween have only indirect test coverage.
- Task 7: minor (deferred): validateParams edge cases (years <= 0, non-integer years, non-boolean market_convention) have no test.
- Task 8: minor (deferred): utilityClaim fill ratio has no lower bound (negative diem_supply would misbehave); unreachable with real data.
- Task 8: minor (deferred): no test for the fill cap at 1 (diem_supply > diem_target_supply).
- Task 10: minor (deferred): run.ts reported supplyAtHorizon/stakingYield are the inputs of the final iteration while target is its output (gap < 0.1% when converged, unbounded when converged=false). Comment it or recompute once at the converged target.
- Task 10: minor (deferred): no test asserts the 6m horizon; Math.pow(1+y, H) is a no-op in every assertion (H=1). One 6m stakedTotalReturnPct assertion would close it.
- Task 10: minor (deferred): no component-kind module is run through runEngine in tests (unweighted add, weight:null, exclusion from dispersion, and the price->module-value feedback via utility_claim are unexercised).
- Task 10: minor (deferred): non-convergence path untested (converged:false, iterations===20, propagation to EngineOutput.converged); ScenarioOutput.probability never asserted.
- Task 10: minor (deferred): if next clamps to 0 the convergence denominator collapses to 1e-12 and a zero target can make forecastSupply throw; unreachable with the three shipped modules (all non-negative), reachable once a module can return a negative value.
- Task 10: minor (deferred): ModuleSummary.breakdown aliases the base scenario's breakdown object rather than copying it.
- Task 10: minor (deferred): a few lines in run.ts exceed 120 chars (no linter configured).
- Task 11: minor (deferred): contrast tests for unlock dilution and buy-and-hold shrinkage assert direction only, not magnitude (plan-mandated strength).
- Task 12: minor (deferred): signals/build.ts and schema.ts hardcode bear/base/bull instead of iterating SCENARIOS.
- Task 12: minor (deferred): no test pins data_quality.open_anomalies === 0.
- Task 13: minor (deferred): updateRunStatus is an unguarded UPDATE; add `AND status = 'pending'` and check changes === 1.
- Task 13: minor (deferred): no test asserts valuation_runs.status leaves 'pending' or reads back the blocked run/signal rows.
- Task 13: minor (deferred): no tests for engine_version_mismatch, run_not_found, cause 'both', whatIf unknown override key.
- Task 13: minor (deferred): blocked-replay test asserts on message text, not OrionError code not_replayable.
- Task 13: minor (deferred): insertSignal stores JSON.stringify(signal) rather than canonicalJson(signal).
- Task 13: minor (deferred): replayRun does not re-verify the recomputed config hash against run.configHash.
- Task 13: minor (deferred): whatIf can in theory return { blocked: [] }; target_delta_pct null conflates absent target with previous target 0.
- Task 14: minor (deferred): `model whatif --as-of` lacks the invalid-timestamp guard that `model run` has; a malformed value surfaces as a raw RangeError instead of OrionError('invalid_timestamp').
- Final: deferred to sub-project 2/3 (not in the fix wave): latest-signal ordering under --as-of backfills; change.cause has no value for config/as-of changes; commander errors not JSON under --json; offset-less timestamps parse as local time; snapshot IN(...) growth; recording process.version on runs; package.json leftovers; total-return variant multiplier vs blended staker share (~0.2pp); utility_claim holds DIEM price at spot; YAML syntax error surfaces raw; remaining CAN DEFER test gaps.
- Final: minor (deferred): whatIf's invalid_config branch has no test; a stored period_days of 0 from before this wave would still be skipped; overlap check spans a flow metric's whole history, so a long-past overlap blocks runs until a row is rejected; an overlapping provisional row on an allow_provisional flow metric can block a run (remedy: orion data reject).
