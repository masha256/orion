# Sub-project 6 (AERO onboarding): rulings and follow-ups

Carried out of the subagent-driven execution of `docs/superpowers/plans/2026-09-23-orion-aero-onboarding.md` on branch `feat/aero` (tasks 1 to 3, a final whole-branch review, one fix wave, and a scoped re-review; 677 tests before, 696 after; engine unchanged). The working ledger was scratch; this file is the durable record. Task 4 (the user's checkpoints) is listed at the end.

## How the execution went, in one paragraph

The plan's code was generated from a per-task prototype and verified by extraction; every implementer applied it byte for byte. The reviews found two contract-reading errors the planning pass had made, both against Aerodrome's `Minter.sol`: the rebase uses voting power at the epoch's start (`ve.totalSupplyAt(activePeriod - 1)`), not the AERO locked (Task 2's review, verified from the source); and the team share applies its rate to the rebase plus the frozen `weekly` state variable, not the tail emission (the final review, against the 2026-09-17 mint in the user's research note, verified by decoding the receipt). With both fixed the adapters reproduce that mint to the coin. The final review also found the 30-day run rate against the 90-day flow window made the measured capture 0.53 for one and the same series, and that one 7.9M USD day doubled the run rate; the window is now 90 days. The final review ran a live tick from a throwaway home: every source ok, a blocked signal at grade A, a bootstrap due, an empty inbox; with a synthetic set, an ok signal.

## Open after the merge (first things to do)

- Task 4 checkpoints, in order: `orion persona assign aero onchain-dex-analyst`; `orion data fetch aero --dry-run`; the first tick (`./run-daily.sh aero`: a blocked signal and a journal-only bootstrap, exit 2); the calibration sweep with priced packages; the bands by the mirror rule into `assets/aero.yaml` (the hash pin in `tests/assets/aero.ingest.test.ts` moves on purpose); the first signal; a second Hermes job line for `aero`.
- At calibration, settle whether the 2026-09-09 fee day (7.9M USD, 53 times the median) is real fee flow or a DefiLlama catch-up; it sits in the 90-day windows until 2026-12-08, which is also the first date the `driver_deviation` trigger can fire on AERO from its roll-off.
- Checkpoint 1 gains one read: `AERO.balanceOf(VotingEscrow)` (990.6M in the research note) against `ve.supply()` (1,051M); the asset file uses `supply()` as the spec says; either gives 50 to 53 percent locked.

## Rulings the controller made on the user's behalf

Each line: what was decided, why, and what it costs if wrong. Review these and rework any you disagree with. In the order they were made.

- ## Rulings (pre-flight)
- Ruling: work in place on branch feat/aero, no worktree - as sub-projects 1-5 - cost if wrong: none.
- Ruling: implementers apply each task's directives with `python3 .superpowers/sdd/2026-09-23-orion-aero-onboarding/apply_plan.py --plan <plan> --repo . --task N --group tests|impl` (proven byte-identical for all 3 tasks) and follow the step order - cost if wrong: a directive can be applied by hand.
- Ruling: models - implementers haiku; task reviewers sonnet for Tasks 1 and 3, opus for Task 2 (contract arithmetic against the Minter source); final whole-branch review on fable - cost if wrong: a weaker task review, backstopped.
- Task 2: Ruling: finding 1 (Important, plan-mandated) - VERIFIED from Minter.sol: `calculateGrowth` uses `ve.totalSupplyAt(activePeriod - 1)` (voting power at the epoch's start), not `ve.supply()`; the spec's 2.1 and 5 were wrong. Decided: the adapters read `Minter.activePeriod()` in the first multicall and `ve.totalSupplyAt(activePeriod - 1)` in a second; the rebase uses that; `ve.supply()` stays the locked-supply metric in the asset file (a separate contract_read); the pinned figures move (share about 0.1017, annual about 248.0M); spec 2.1/5 amended at finish - cost if wrong: none; it now follows the contract.
- Task 2: Ruling (carried into Task 3): the voting-power fix adds two reads the plan's Task 3 canned fetch does not fake. The Task 3 implementer adds, after applying the tests group, `[callKey(C.minter, 'activePeriod')]: 1789603200n` and `[callKey(C.ve, 'totalSupplyAt', [1789603199n])]: 1027321406167859438293364475n` to the fake RPC calls in tests/assets/aero.ingest.test.ts and raises the multicall bound to 5 (verified in the scratch clone: 693 tests) - cost if wrong: none.
- Final: Ruling: F1 (Important) - VERIFIED on chain by the controller (tx 0xd75b...288f receipt): the mint was 4,790,434 with 4,154,746 to the Voter, 481,314 to the RewardsDistributor, 220,498 to the team. The team term of the adapter (rate on growth + base) gives 108,168; the contract applies the rate to growth + `weekly` (the state variable, frozen at TAIL_START in the tail): 228 * (481,314 + 8,969,149.54) / 9,772 = 220,498 exactly. Decided: the adapters compute `team = teamRate * (growth + weekly) / (BPS - teamRate)` with `weekly` the read; a test reproduces the observed mint from derived constants (total before the mint 1,978,450,286 from the base term; voting power 1,026,102,xxx from the rebase); the pinned figures move (gross about 4.87M a week, about 253.9M a year, share about 0.0994) - cost if wrong: none; it now matches an observed mint to the coin.
- Final: Ruling: F2 (Important) - the 30-day run rate against the 90-day holder-flow window makes the measured capture 0.53 for a series that is by construction the same, and one 7.9M USD day (2026-09-09) doubles the run rate until it rolls off on 2026-10-10. Decided: `revenue_run_rate_usd` derives over 90 days, matching `window_days`; the spike is diluted threefold; the deviation lag becomes a quarter; the asset test's chart grows to 100 days; spec 3 amended. The user hears about the 09-09 day at calibration (real fees or a DefiLlama catch-up) - cost if wrong: a slower revenue driver, which for a fee series is the conservative side.

## Deferred findings (not fixed in sub-project 6)

- Task 1: minor (deferred): `DERIVED_NAMES` is `readonly string[]`; typing it `readonly DerivedName[]` would let the compiler enforce the cast in run.ts.
- Task 1: minor (deferred): no `flow_annualized`-specific test for a window of 1 (covered through the shared helper by burnMomentum's tests).
- Task 2: minor (deferred): `tail_start` given as a YAML string is silently ignored by `number()` (VVV has the same).
- Task 2: minor (deferred): the test's `expected()` re-implements the formula; the independent checks are the detail regex and the bounds.
- Task 2: minor (deferred, FIX IN THE FINAL WAVE): the TAIL_START comparison runs in floats, so a `weekly` within 1e-9 AERO below the threshold is refused where the contract would not; compare the raw bigints and make the "one wei below" test really one wei.
- Task 2: minor (deferred, FIX IN THE FINAL WAVE): `activePeriod` 0 makes `0n - 1n` an invalid ABI argument; a one-line guard would name the fault.
- Task 2: minor (deferred, FIX IN THE FINAL WAVE): the team-rate guard has no test.
- Task 2: minor (recorded): the re-reviewer questioned the Fable trailer; the session's attribution rule is Fable 5.1, so it is right.
- Task 3: minor (recorded): the 693 count against the brief's 691 is Task 2's two added tests.
- Final: minors parked (may wait, per the triage): the two adapters' duplicate multicalls (memoize by block if the RPC ever throttles); flat schedule step versus compounding emissions (~0.7% of supply at 12m, re-anchored daily; engine-level); `VE_TOTAL_AT` in the tests is a stand-in from `totalSupply()`; spec 9.3's "second Hermes line" lives in Checkpoint 5, not the README; `balanceOf(ve)` 990.6M against `supply()` 1,051M is a Checkpoint 1 read; the deviation trigger's first AERO firing is predictable (the spike roll-off, now 2026-12-08 with the 90-day window).

## Task 4: the user's checkpoints

From the plan's Task 4, unchanged in substance: (1) assign the persona and dry-fetch on the live home; (2) the first tick, expecting a blocked signal, a journal-only bootstrap, exit 2 (a hand-launched deep after calibration skips it); (3) calibration by sweep, import, bands, commit; (4) the first signal, recorded here with the spot, the 12m target, and the dispersion; (5) the second Hermes line; (6) this note and the spec's status line, which are done.

## The figures as fixed (2026-09-23 reads)

- Weekly gross mint in the tail regime: base 4,164,806 (21 basis points of 1,983,240,736), rebase 483,789 (on voting power 1,027,321,406 at the epoch's start), team 220,610 (228 basis points on the rebase plus the frozen `weekly` of 8,969,149.54, grossed up): about 253.9M AERO a year, 12.8 percent of supply; the lockers' rebase share about 0.099.
- The 2026-09-17 mint (tx `0xd75b...288f`) reproduced to the coin: 4,154,746 / 481,314 / 220,498.
- Revenue run rate over 90 days; the asset file's hash pin is `eb39a2307aeff731889630f74152055941db8e49aa2cc88bc5a159e1d2c37f78` until the bands are written.

## Residual minors from the fix wave's re-review (recorded, not fixed)

- A non-integer `tail_start` param is rounded to the nearest AERO before the bigint comparison, and a non-finite one throws a bare RangeError rather than a named refusal; the default and every configured value are integers.
- The share test's lower bound was widened to 0.09 where 0.095 would still pass; the binding assertion is the exact `toBeCloseTo`.
- The mint-reproduction test pins the rebase to `48131\d`; base and team are pinned to the coin.
