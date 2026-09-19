# Sub-project 2 (ingestion, anomalies, dilution fix): rulings and follow-ups

Carried out of the subagent-driven execution of `docs/superpowers/plans/2026-09-19-orion-ingestion.md` on branch `feat/ingestion` (tasks 1 to 20 plus the final-review fix wave, on top of `main` at `12ef356`; 328 tests, engine 1.2.0). The working ledger was scratch; this file is the durable record. Task 21 (the live checkpoint) is the user's and is not recorded here.

## Open decision for the user

**An acknowledgement does not survive the next fetch.** The code follows spec 6.3 to the letter ("a resolved or acknowledged anomaly that recurs opens a new row"), and the daily fetch re-evaluates every cross-check. So a persistent mismatch that was acknowledged opens a new OPEN row the next day, and on a critical metric the signal is `degraded` again. The README's own example ("Venice's API lags") is such a condition. Proposed amendment from the final review: a repeat whose latest matching row is `acknowledged` updates that row (occurrences, last seen) instead of opening a new one; `resolved` plus recurrence still opens a new row. Not changed in this branch because it changes approved spec behaviour. Decide before relying on the cron. A re-scan that sees old unlisted transfers again reopening a resolved `unlisted_sender` is the same issue.

## Rulings the controller made on the user's behalf

Each line: what was decided, why, and what it costs if wrong. Review these and rework any you disagree with.

- Ruling: commit the plan, spec amendment, and two fixture captures on spec/ingestion (d5e340a), then work in place on a new branch feat/ingestion, no worktree — the user said "continue with plan" after being told these were uncommitted and that execution commits per task; sub-project 1 ran the same way and Task 21 needs the user's repo-root orion.db from this directory — costs nothing if wrong (one docs commit, a branch that can be moved to a worktree at any time).
- Ruling: Task 21 (live user checkpoint) is NOT dispatched; the controller presents it to the user at the end — it touches the network and the user's real orion.db and is a human decision by design — costs nothing if wrong.
- Ruling: Task 12 blocks the WHOLE scan group on a flow conflict, where spec 5.1 says "nothing is written for that metric" — the cursor is shared by the group, so writing other members and advancing it would leave a permanent silent gap in the refused metric; stricter than the spec, never looser — if wrong, cost is a per-metric cursor redesign.
- Ruling: Task 16 writes usage_index for every day with a full window and no index row, where spec 7 says the newest day only — each value derives only from real rows, and without history the stale-revenue alert has nothing near the 2026-08-17 disclosure for a month; flagged for the user at Task 21 — if wrong, a three-line change.
- Ruling: spec section 8 amendment (no burn yield in the post-horizon path) is already approved by the user; Task 1 follows the amended spec.
- Task 12: Ruling: reviewer finding (plan-mandated, Important) — the period-overlap formula appears twice in flow.ts (findFlowConflicts and the per-day adoption check). Decided: fix it — extract one small unexported helper in flow.ts and use it in both places; no later task edits flow.ts by exact-text replace, and the spec is silent on code shape — two copies of a boundary rule ("touching is not overlapping") are exactly the kind of thing that drifts — cost if wrong: a few lines of churn.
- Task 17: Ruling: reviewer finding (plan-mandated, Important) — narrowToUsable drops observations of metrics the asset no longer declares, including scheduled_unlock_tokens events, while computeDrivers reads that key without checking the declaration. Decided: behavior stands. Dropping undeclared metrics is NOT new: sub-project 1's eligibleObservations already filtered `def !== undefined` before computeDrivers ever ran (valuation.ts at 2fbe4b9, lines 22-25), the parent spec defines eligibility that way, and this task's brief tests it ("drops ... metrics the asset does not define"). So no run's output changes. What IS wrong is narrowToUsable's docstring, which claims everything dropped is something computeDrivers would ignore; that holds only for declared metrics. Fix: docstring only, stating the precondition — cost if wrong: an asset whose config drops an optional event metric loses those unlocks silently, exactly as it did before this task.
- Final: Ruling: Important 3 (an acknowledged anomaly that recurs opens a new OPEN row the next day, so an ack holds for one fetch) is NOT fixed in this branch — the code follows spec 6.3 to the letter ("a resolved or acknowledged anomaly that recurs opens a new row"), and changing the lifecycle is a spec decision that belongs to the user, who is present at the Task 21 checkpoint anyway; present it there with the reviewer's proposed amendment (a repeat whose latest matching row is `acknowledged` updates that row; `resolved` plus recurrence still opens a new one) — cost if wrong: one more small change after the checkpoint; until then a persistent acknowledged mismatch on a critical metric re-degrades the daily signal.

## Defects the final whole-branch review found in the plan, fixed in the fix wave (b5c958f..0f52b12)

- `--metric` on one member of a shared transfer scan advanced the shared cursor and left permanent gaps in the other members. Now a requested `transfer_flow` metric pulls in every metric that shares its scan.
- `orion update` valued at the pre-fetch time, so chain observations stamped with a later block time were ignored (a fresh database gave a `blocked` signal). It now values at the later of the post-fetch clock and the newest observation the fetch wrote. No observation timestamp is altered.
- Minors taken in the same wave: viem error text could carry a keyed RPC URL into the database and logs; the derived `usage_index` was not recomputed after a re-scan changed a day; the HTTP body read sat outside the retry path; `.env` inline comments; SQLite `busy_timeout`; import tidy; three README notes.

## Deferred findings (not fixed in sub-project 2)

All were triaged by the final review as safe to carry. Pick them up where later sub-projects touch the same files.

- Task 1: minor (deferred): holderCashflow breakdown explicit_pv_usd / terminal_pv_usd are per-token PV times S(H), a display convenience that does not reconcile to nominal flows (stated in the note text; spec section 8 mandates it).
- Task 2: minor (deferred): recentSourceStatuses JSON-parses fetch_runs rows newest-first until `limit` hits; worst case scans an asset's whole history (fine at daily volume).
- Task 3: minor (deferred): no test lists decided anomalies across more than one asset with includeDecided and no assetId filter.
- Task 4: minor (deferred): sources.test.ts title mentions transfer_flow as a cross-check but only derived is exercised; no test puts a source on an event metric.
- Task 5: minor (deferred): no test verifies the configured timeoutMs reaches AbortSignal.timeout (the fake fetch ignores init.signal).
- Task 6: minor (deferred): viemRpc.multicall calls parseAbi once per call (512 times for the DIEM tables); memoize by signature if it ever shows up in a profile.
- Task 7: minor (deferred): defillama handler throws for the whole batch on the first malformed chart, coarser than http_json's per-URL isolation (one defillama source per asset today).
- Task 7: minor (deferred): sources.api.test.ts registers test adapters into the module-level registry with no teardown (vitest isolates modules per test file; Task 15's test uses arrayContaining).
- Task 10: minor (deferred): the plan's Task 10 "Consumes" list names `narrow`, which plan.ts does not need (the discriminated union narrows on its own). Documentation only.
- Task 11: minor (deferred): fetchAsset is one long phased function (~115 lines now, grows with Tasks 13 and 16); final review to judge whether the phases should become functions. FetchDeps.sleep is unused until Task 13 passes it to the scan.
- Task 12: minor (deferred): untested branches in flow.ts: invalid_source_config for a usd member without a price id; decimals() call failure. (The dry-run + --adopt note is covered by Task 13's run.flows test.)
- Task 13: minor (deferred): bySender grouping rebuilds an array per unlisted transfer (quadratic in a sender's transfers; unlisted transfers are rare by design).
- Task 14: minor (deferred): signalSummary's new "open anomalies" line and its `?? []` fallback for pre-sub-project-2 stored signals have no direct test.
- Task 15: minor (deferred): invariant 5 is schema-enforced for http_json only; an adapter that wraps an undocumented API (vvv.staker_share_from_api) could be configured as the primary of a required metric. Final review to judge whether AdapterDef should carry a crossCheckOnly flag checked in buildPlan.
- Task 16: minor (deferred): checkRevenueStale's tie between two equidistant index points and the exact seven-day boundary are untested.
- Task 17: minor (deferred): no test exercises "the larger window wins" with two holder flows sharing a metric; eligibility.ts and select.ts each compute the newest period end (cross-reference comment or shared helper if a third use appears).
- Task 18: minor (deferred): `data fetch` with no asset aborts at the first asset whose config is invalid, so later assets are not fetched (spec invariant 3 is about sources within one asset; one asset exists today). Final review to judge a per-asset try/catch.
- Task 18: minor (deferred): the no-asset path loads each asset YAML twice.
- Task 19: minor (deferred): no test drives `orion update` to a degraded signal to pin exit code 0 there (only blocked is special-cased, so it is correct by construction); the action's opts type omits the unused `json` flag.
- Task 20: minor (deferred): the VVV end-to-end test uses a 2-day backfill, so it never reaches a completed month and does not exercise the two flow cross-checks with the real config.
- Final: logs and levels are read at the latest block with no confirmation margin (immaterial at the documented 00:15 cron; note it if anyone schedules the run at midnight UTC).
- Final: the two flow cross-checks (DefiLlama monthly USD, Venice burn history tokens) have never run against real data with the real config: the planning-time live dry run covered one day. The Task 21 backfill is their first real exercise.
- Carried again from sub-project 1: the data-quality grade counts every manual metric, required or not; `change.cause` has no value for a config or as-of change; commander errors are not JSON under `--json`; offset-less timestamps parse as local time.
