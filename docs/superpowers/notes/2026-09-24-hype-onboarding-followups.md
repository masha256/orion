# HYPE onboarding (sub-project 7): rulings, deferred findings, and the user's checkpoints

Written 2026-09-25 at the end of execution, from the SDD ledger. Spec: `docs/superpowers/specs/2026-09-24-orion-hype-onboarding-design.md` (sections 11 and 12 carry the amendments). Plan: `docs/superpowers/plans/2026-09-24-orion-hype-onboarding.md`. Branch `feat/hype` off `main` at `dfd622a`; 7 commits; 697 -> 717 tests; tsc and build clean; the final whole-branch review found no Critical or Important code finding.

## How the execution went, in one paragraph

Three tasks, each applied from the plan's directives by a haiku implementer (byte-identical to the prototype every time), then task-reviewed (sonnet for Task 1, opus for Tasks 2 and 3). Task 1 passed clean. Task 2 needed two fix rounds: the review found two spec requirements the plan's own code had pinned wrong (a missing non-circulating list subtracted zero silently; the emission exponent was not a param) and two test gaps in the first fix. Task 3 needed two fix rounds: the live dry run had not written the run rate because the backfill equalled the derived window and DefiLlama lags the UTC rollover, and the report claimed it had; then the controller's own burn-bound numbers turned out wrong and were re-based on the engine's real figure. The final review on fable confirmed every cross-task risk in the code (the run cache sharing one POST between two adapters, no RPC dependence, the engine's burn and premium wiring, the 100/90 backfill, the grade B cap) and asked only that the spec amendments be committed.

## After the merge: the dry-run fix (2026-10-02)

The user's checkpoint-1 dry run failed the effective-supply adapter with a timeout: the `tokenDetails` reply is 5 MB of genesis balances and the API served it too slowly for the 15-second timeout, three times. Fixed on `main` as a bounded change (spec amendment 9): total supply from `spotMetaAndAssetCtxs` (300 KB), each subtracted balance from its `spotClearinghouseState` (small), a 60-second per-host timeout for the info API; five small posts per tick, cached. The dry run then passed in 33 seconds on the same slow link; the hash pin did not move. Deferred: if the 300 KB spot meta still times out on a very slow day, the source fails for that day and the previous value stands within its 7-day staleness.

## Open after the merge (first things to do)

- Task 4 checkpoints, in order: `orion persona assign hype perp-exchange-analyst`; `orion data fetch hype --dry-run`; the first tick (`./run-daily.sh hype`: a blocked signal, a bootstrap that researches `staker_emission_share`, exit 2); confirm the row from the inbox; the calibration sweep with priced packages (show the 30-day and 1-year run rates beside the 90-day one); the bands by the mirror rule into `assets/hype.yaml` (the hash pin in `tests/assets/hype.ingest.test.ts` moves on purpose; also reword the `unvested` comment then, see deferred 4); the first signal; a third Hermes job line for `hype`.
- **Before confirming the bootstrap's staker-share row, check its `observed_at`.** The metric's staleness is 400 days and the engine measures staleness from the row's date. A row dated at the 2024-11-29 genesis ("when the figure was true") is stale on day one and grades the signal C instead of B. If the row is dated more than a year back, reject it and enter the value with the fallback, which dates it now: `orion data set hype staker_emission_share 1 --detail "all staking rewards go to stakers (docs, hypercore/staking, read 2026-09-24)"`.
- Grade B is the ceiling for HYPE by design (a manual row in force caps the grade); do not read B as a data problem.
- The market pays about 150 times the 90-day run rate on the effective supply; the calibrated base case will sit far below spot at any ordinary discount rate (the user was told during design; do not re-litigate at calibration).

## Rulings the controller made on the user's behalf

Each line: what was decided, why, and what it costs if wrong. Review these and rework any you disagree with. In the order they were made.

### Pre-flight

- Work in place on branch `feat/hype`, no worktree, as for sub-projects 1 to 6. Cost if wrong: none.
- Implementers apply each task's directives with the git-ignored `apply_plan.py` (proven byte-identical for all three tasks). Cost if wrong: a directive can be applied by hand.
- Models: haiku implementers; sonnet reviewer for Task 1, opus for Tasks 2 and 3; fable for the final review. Cost if wrong: a weaker task review, backstopped by the final one.

### Task 1

- The spec's section 4 wording ("response-size limit", "a truncated body") describes what GET never had; `postJson` shares what GET has. Amended (12.6) rather than adding a limit or a body excerpt. Cost if wrong: an oversized reply is read whole, as it always was; the one large reply (`tokenDetails`, about 5 MB) is named in the amendment.

### Task 2

- Both Important findings hold against the spec, which binds over the plan's code: refuse a missing or malformed non-circulating list (and a malformed `subtract` param) by name; add an `exponent` param (default 0.5, refused outside (0, 1]). Cost if wrong: two more refusal paths and one param nobody changes.
- The review's minors 2 to 4 (malformed `subtract`, a negative per-validator stake, pin the recorded fixture figures directly) rode in the same fix round. Cost if wrong: a few extra test lines.

### Task 3

- `backfill_days` becomes 100 on `assets/hype.yaml` while the derived window stays 90, so the first fetch writes the critical run rate even when DefiLlama has not posted the newest day; the hash pin moved; spec 12.7. AERO keeps its 90/90 shape. Cost if wrong: ten more flow rows on the first HYPE fetch.
- The five test minors rode in the same fix round with the report correction. Cost if wrong: a few test lines.
- The controller's own burn-bound offsets (4M to 10M tokens) were wrong: with the wiring set's flat assumptions the engine's target is about 12 USD and the linear price path makes the burn buy about 16.1M tokens; the assertion is a band of 12M to 20M on effective supply plus a year of emissions. Cost if wrong: a test bound that needs retuning if the wiring set changes.

### Final

- The one Important finding was the controller's own uncommitted documentation (spec amendments 6 to 8); committed with this note, no fix subagent. Cost if wrong: none.
- The genesis-dated-row hazard (final minor 1) is a checkpoint instruction (above), not a code change. Cost if wrong: a C-grade first signal until the row is re-entered.

## Deferred findings (not fixed in sub-project 7)

1. An unknown contract name in an adapter's `subtract` param (or AERO's contract params) fails the source on every run instead of failing config validation; a cross-cutting fix would validate adapter contract params in `sourceIssues`.
2. AERO has the same 90-day backfill as its 90-day window; a lagging DefiLlama day delays its run rate by one day, within its staleness of 5. Revisit only if the deviation trigger misfires.
3. The Task 1 POST retry test asserts two behaviours in one `it` (plan-mandated); no direct 429 test on `postJson` (the shared branch is covered by GET's).
4. `contracts.unvested` in `assets/hype.yaml` is read by nothing; its comment should say "not read" as well as "inside the effective supply". Editing it moves the hash pin, so it waits for the calibration edit (checkpoint 3).
5. `withRunCache` keys a POST by URL and body, not headers; no caller posts the same body with different headers. A comment would record the choice.
6. The Task 3 report's first section still claims the run rate "would write"; the fix-round sections below it carry the corrected dry run. Ledger housekeeping only (archived in the session scratchpad).

## The figures as fixed (2026-09-24 reads and fixtures)

- Recorded fixtures (2026-09-24T23:40Z): total supply 998,909,900.86; Assistance Fund 47,478,177.05; zero address 1,673.79; dead address 2.72; effective supply 951,430,047.30; validator stake summed 440,716,882.75 (35 validators); emissions 9,950,804 a year (2.258 percent) at that stake and 9,480,000 at the docs' 400M anchor.
- Live dry runs: planning (23:48Z) price 92.11 against DefiLlama 92.105, 90 flow days, run rate 570.2M USD; Task 3 after the fix (2026-09-25) every source ok, `would write revenue_run_rate_usd`.
- The asset file's hash pin is `618c7918bda7e2ce6159597dd7e2b955f75f5ad646bdba116f4adf5f969767e5` until the bands are written.
