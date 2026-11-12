# Orion Phase 3 R0b + R1 (remote verbs, third-party removal): followups (2026-11-12)

Spec `docs/superpowers/specs/2026-11-09-orion-phase3-third-party-removal-design.md`, plan
`docs/superpowers/plans/2026-11-12-orion-phase3-r1-third-party-removal.md` (Tasks 1-8). Branch
`feat/phase3-third-party`, built in a worktree, not merged, not tagged, not deployed. Release steps: `docs/ops/deploy.md`
"Phase 3 R1 release" (the one-time `orion-host.sh` re-run, the verb reference, the per-env release block).

## R1 decisions (P1-P5)

Mike's go on the plan covers these (plan "Plan decisions").
- **P1 Backfills run as a daemon job, not a long SSH session.** `job run-now backfill <a> --metrics ... --backfill-days
  N`; the single worker runs it at priority 70 (after refresh, nightly, push, levels, watch), one attempt, no retry;
  it defers to 2 h after the env's next nightly slot when that slot is under 4 h away. A synchronous verb would die
  with the SSH connection and race deploys.
- **P2 `data purge` is a remote verb that dry-runs by default.** `--yes` deletes after writing the rows to
  `$ORION_HOME/purged/<asset>-<metric>-<UTCstamp>.json`. Refuses the rows of a metric's current source type, a metric
  with an open anomaly, and a kept row that references a deleted row. Prod purges only on Mike's go.
- **P3 R0b and R1 ship as one release** (0007 is expand-only; R1's value moves are P4's two).
- **P4 Unlock citations.** LIT: Lighter's own post (team 26%, investors 24% = 500M; 1-year lock, 3-year vest; monthly
  tranches from 2027-01-29 as approved in proposal #3); next-365-day figure 138,796,789 -> 138,888,889 (+0.066%).
  PUMP: no pump.fun vesting schedule published (searched 2026-11-12); allocation sizes (team 20%, investors 13% =
  330B) and lock/vest terms (12-month lock from 2025-07-12, then linear 3 years) cited from the Blockworks Token
  Transparency filing (compiled by Blockworks, labelled so); value unchanged at 82.5B a year. If Mike rejects a
  non-issuer citation, PUMP's `unlocks` goes `not_measured` (dilution null): a value change he would have to approve.
- **P5 R1 drops checks without replacing them.** LIT's buyback check (fills vs the treasury's LIT balance, a
  `two_path`) and VVV's `usage_index` watch are built in R3. Until then LIT's buyback and VVV's burn have no external
  check (their own reconciliation checks stay).
- Dropped from spec §3.4: `db backfill-provenance` (gone since 0006) and `data backfill-tokens` (one-time Phase 2 fill,
  done on both envs). R2 adds its price-history rebuild as a second `backfill` op (`op: prices`) on this job kind.

## Rulings during execution

Controller rulings from the SDD ledger, one line each with its cost if wrong.
- R1: code lands on `feat/phase3-third-party` itself (spec + plan branch), the Phase 2 pattern. Cost: none (rename at
  merge).
- R2: Task 2's tests use a synthetic fixture asset with a non-third-party configured source to exercise
  `purge_live_source`, independent of Task 4's adapter. Cost: none.
- R3: orion-remote's `data purge` / `data compare-usd` append `--json`, like every other `data` verb. Cost:
  human-readable output over SSH instead of JSON.
- R4: Task 3 writes deploy.md "Phase 3 R1 release" (`orion-host.sh` re-run, verb reference); Task 8 appends the per-env
  release block. Cost: none.
- R5: Task 4 Step 1 (PUMP citation research) done by the controller; the implementer got the url/quote. Cost: none.
- R6: Task 7 split: an implementer writes `flatdiff.py`, its tests and the allowlist skeleton; the controller runs
  Steps 3-8 (prod copy, fetches, comparisons, purge and backfill rehearsal). Cost: none.
- R7: Task 8 Step 1 (profile soak parity file, soak cron prompt, outside the repo) is the controller's; the implementer
  writes Steps 2-3 (docs). Cost: none.
- R8: Task 1's edits to four pin tests (migration count / kind lists 0007 forces) accepted; Task 3 drops the `backfill`
  exclusion in tests/release/orionRemote.test.ts. Cost: none.
- R9: the extra guard kept: a backfill also defers while a nightly began under 2 h ago (until slot + 2 h), so a backfill
  claimed at 00:46Z can't block that night's refreshes. Cost: a run-now between 00:45Z and 02:45Z waits until 02:45Z.
- R10: a queued backfill on a rollback to orion-2026.11.11.1 fails "no handler" with no retry; deploy.md says
  drain/finish backfills before a rollback. Cost: one failed job row.
- R11: backfill run time stays unbounded in code (a hard timeout would discard a partly written backfill); sizing is
  documented in deploy.md and the duration is in the Slack line. Cost: an oversized backfill delays one nightly.
- R12: Task 1's fix round 1 waited for Task 2's implementer (one implementer in the worktree at a time) and landed as
  its own commit. Cost: none.
- R13: `purgeMetrics` taking `OrionDb` (src/db -> src/app/lock import) accepted: the lock must wrap the delete
  transaction; no cycle. Cost: a layering nit.
- R14: the `latest_levels` row left after a third_party purge of a configured metric is handled by order (refresh
  before purge) in the release block. Cost: a stale third-party level shown until the next hourly levels job.
- R15: the backfill start line keeps the env prefix (`ORION BACKFILL <env> <SYM> started: ...`) like every daemon line.
  Cost: a cosmetic mismatch with the findings' text.
- R16: Task 4's 180 days (not the plan's 182) for linear start 2026-07-12 / 3 y at now 2029-01-12 is right under the
  plan's own rule (start + years x 365 d = 2029-07-11, 2028 leap); 182 was a controller slip. Cost: none (test pins the
  rule).
- R17: Task 5's one-line `as string[]` cast in tests/assets/lockers.ingest.test.ts accepted (type widening). Cost: none.
- R18: Task 6's goldens rewrite (tests/report/golden/v2-report-13.json, tests/agent/golden/packs-13.json) accepted
  pending review: only CAKE/UNI volume, the VVV cross-check and third-party provenance entries may move. Cost: a golden
  that hides an unintended move (Task 7's prod-copy proof is the second net).
- R19: the disclosure e2e rebuilds the 2026-10-23 lit.yaml in the test's copy (old unlock adapter line, the two
  DefiLlama series); fixtures byte-unchanged. Cost: none.
- R20: prod_copy.py passes `--breaking` to the old release's migrate (the target is always a fresh `p2proof_*` scratch
  schema), separate tools commit with a unit test. Cost: none (scratch only).
- R21: LIT's +0.066% unlock change flows into the dilution-derived fields (yields.dilution, yields.netShareholder,
  holderFlow.netOfDilution, perToken.dilution, perToken.holderFlow.netOfDilution, perTokenFdv.*, the unlocks line's
  yield / dilution.pct / dilution.tokensPerYear): rel 0.0007 (PUMP: same paths, rel 1e-12); supply.netPerYear abs
  100000 tokens; a todo placeholder for incomeStatement.checks[...]. Cost: a bound too loose by < 0.07% on LIT
  dilution-derived fields.
- R22: the `perTokenFdv.*` glob stays unbounded-by-path at rel 0.0007; the controller reads every flatdiff path and
  treats any perTokenFdv revenue / grossProfit / holderFlow.total move as a stop (FDV doesn't move in R1). Cost: none
  (manual check).

## Deferred minors

From the task reviews, not fixed in R1.

Task 1 (`backfill` job kind):
- M-1 `message` / `codeOf` copied from refresh.ts: export one copy.
- M-2 `ctx.signal` not passed into fetch (lease loss keeps running; same gap as refresh).
- M-4 job.ts:68 checks `trim()` but converts the untrimmed string (correct result).
- RR-1 an orphaned unfinished refresh/report row of the newest slot defers every backfill silently until the next
  nightly.
- RR-2 derived requested metric: an input source failure doesn't fail the job unless the derived source fails (no
  current config hits it).

Task 2 (`data purge`):
- M-6 the dead API-flow cursor (`defillama:...>metric`) of a configured metric is kept after a third_party purge (see
  "Carried to later releases").
- M-7 tests/db/pg/migrate.test.ts "could not open relation with OID" flake under `--maxWorkers=2` (passes alone):
  known flake.
- RR-1 an export file is left in `purged/` when the dir fsync fails (nothing deleted): best-effort unlink.
- RR-2 the DB-dependent refusals (open anomaly, dangling ref) still run under the lock; a refused `--yes` may abandon
  orphaned agent runs.

Task 3 (orion-remote verbs, deploy.md):
- the nine-rung list in orion-remote is not pinned against TS `SourceType` (`JOB_KINDS` is).
- flake: tests/push/gitPublisher.test.ts "a moved remote is refused..." timed out once at `--maxWorkers=2`
  (load-sensitive).
- `assert_refused`'s per-word substring check could false-fail on short numbers (e.g. `1` inside argc `10`).

Task 4 (schedule unlock adapter):
- M1 the "tranche on now+365d counts; on now does not" test also passes with swapped window ends (only the month-end
  test catches it): strengthen.
- M2-M7 `originOf` condition could be tighter; tranche loop duplicated with lit.ts (the lit adapter retires in R8); a
  few validation tests missing; billions print as 50000.00M in detail; one test monkeypatches the shared registry; the
  `schedule_steps` path has no citation guard (hypothetical).

Task 5 (`not_measured` volume):
- refusal tests use bare `.toThrow()`; no committed mixed-form test; list typos give a vaguer "Invalid input"; a
  whitespace-only reason is accepted (as statement lines); the new form is not documented.

Task 6 (asset configs, goldens, register):
- misplaced doc comment in parity.ts; one mis-indented test line; the x.com register row is keyed by host; comment
  rewrites dropped some calibration facts; a replay comment overclaims; coverage gap in r1-third-party.test.ts.

## Carried to later releases

- **R3:** P5's two replacements: LIT's buyback `two_path` check (fills vs the treasury's LIT balance) and VVV's
  `usage_index` watch. Until R3, LIT's buyback and VVV's burn have no external check.
- **R2:** the price-history rebuild ships as a second op on this job kind (`backfill` with `op: prices`), not as a
  new verb or job kind.
- **Dead API cursor (Task 2 M-6):** a third_party purge of a still-configured metric (R1: LIT and PUMP
  `unlocks_next_year`) leaves that metric's old API-flow cursor (`defillama:...>metric`) behind. Nothing reads it while
  the metric's source is no longer DefiLlama. Open: drop it (suggested: in R8 with the `defillama` source type).
- **Purge export files, per env:** each `data purge ... --yes` writes the rows it deletes, before deleting, to one
  file `~/home/purged/<asset>-<first metric>[+N]-<UTCstamp>.json` (`$ORION_HOME/purged/`, src/db/purge.ts) in that
  env user's home on venus: `/home/orion-stage/home/purged/` (stage), `/home/orion-prod/home/purged/` (prod). R1's
  release block writes six per env (one per purge call: cake, lit x2, uni, vvv, pump). With the nightly `pg_dump` they
  are the only copy of the purged rows; nothing prunes them. Their retention is open (suggested: decide with R8).

## Proof

Proof results: see controller commit
