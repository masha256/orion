# Orion Phase 3 R0b + R1 (remote verbs, third-party removal): followups (2026-11-12)

Spec `docs/superpowers/specs/2026-11-09-orion-phase3-third-party-removal-design.md`, plan
`docs/superpowers/plans/2026-11-12-orion-phase3-r1-third-party-removal.md` (Tasks 1-8). Branch
`feat/phase3-third-party`, built in a worktree, not merged, not tagged, not deployed. Release steps: `docs/ops/deploy.md`
"Phase 3 R1 release" (the one-time `orion-host.sh` re-run, the verb reference, the per-env release block).

## R1 decisions (P1-P5)

Mike's go on the plan covers these (plan "Plan decisions").
- **P1 Backfills run as a daemon job, not a long SSH session.** `job run-now backfill <a> --metrics ... --backfill-days
  N`; the single worker runs it at priority 70 (after refresh, nightly, push, levels, watch), one attempt, no retry.
  It defers to 2 h after the env's next nightly slot when that slot is under 4 h away, while a nightly began under 2 h
  ago (until that slot + 2 h; R9), and while that nightly's refresh / nightly_report jobs are unfinished. A synchronous
  verb would die with the SSH connection and race deploys.
- **P2 `data purge` is a remote verb that dry-runs by default.** `--yes` deletes after writing the rows to one file
  per call, `$ORION_HOME/purged/<asset>-<first metric>[+N]-<UTCstamp>.json`. Refuses the rows of a metric's current source type, a metric
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
  Steps 3-8 (prod copy, fetches, comparisons, purge rehearsal; the local backfill rehearsal was skipped, R25). Cost:
  none.
- R7: Task 8 Step 1 (profile soak parity file, soak cron prompt, outside the repo) is the controller's; the implementer
  writes Steps 2-3 (docs). Cost: none.
- R8: Task 1's edits to four pin tests (migration count / kind lists 0007 forces) accepted; Task 3 drops the `backfill`
  exclusion in tests/release/orionRemote.test.ts. Cost: none.
- R9: the extra guard kept: a backfill also defers while a nightly began under 2 h ago (until slot + 2 h), so a backfill
  claimed at 00:46Z can't block that night's refreshes. Cost: a run-now between 00:45Z and 02:45Z waits until 02:45Z.
- R10: a queued backfill on a rollback to orion-2026.11.11.1 fails "no handler" with no retry; deploy.md says
  drain/finish backfills before a rollback. Cost: one failed job row.
- R11: backfill run time stays unbounded in code (a hard timeout would discard a partly written backfill); sizing is
  documented in deploy.md and the duration is in the Slack line. Cost: an oversized backfill delays one nightly; and
  since the daemon has one worker, a running backfill also holds the hourly `levels` job (watch fire/clear posts, the
  levels snapshot) and on prod the dead-man ping, so a backfill over an hour or two can trip the prod dead-man
  (deploy.md says so).
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
- R21: LIT/PUMP dilution-derived bounds (rel 0.0007, supply.netPerYear abs 100000, a checks todo placeholder):
  superseded by R24 / ee295f6; the final fix wave widened LIT's two abs bounds to 120000 / 0.00013 (final review I-2).
- R22: the `perTokenFdv.*` glob with a manual stop: superseded by R24 / ee295f6 for LIT (exact entries); PUMP keeps
  `perTokenFdv.*` at rel 1e-12. The release block's manual read of perTokenFdv paths stays (redundant, harmless).
- R23: no `db status` ssh verb: the release block checks the switch report's migrations applied `[7]` and
  `~/deploys.log` `migrations=7`. Cost: none.
- R24: LIT's four net-of-dilution fields bounded at rel 0.0008 (real move 0.000729), the real provenance / flags paths
  listed exactly, every other todo placeholder deleted (ee295f6). Cost: none.
- R25: the local daemon backfill rehearsal (Task 7 Step 7) skipped: a scratch daemon would enqueue the schedule's newest
  slots (network refreshes, disclosure_watch -> a possible paid analyst run, publish). The handler is covered by Task
  1's tests; its first real run is stage's smoke backfill in the release block (deploy.md step 4: `ssh orion-stage job
  run-now backfill hype --metrics flow_usd.af_buys_direct --backfill-days 3`). Cost: a backfill bug found on staging
  instead of the copy.
- R26: the soak's parity file needs no change (it compares holder gross/net, holder-flow growth, revenue.annualized and
  the day, none of which R1 moves; the UNI/VVV/YCRV default day is unchanged, see Proof); only the soak cron's "known
  queue" line is updated on deploy day. Cost: none.
- R27: the release block purges only the four orphan pairs (CAKE fees + llama_revenue, LIT fees + llama_revenue, UNI
  swap_fees, VVV revenue_proxy; no report reads them); the LIT/PUMP third_party `unlocks_next_year` purge is a separate
  step gated on Mike's pick (see Open decisions). Cost if wrong: 60 third_party rows kept a while longer.

## Open decisions (Mike)

- **LIT/PUMP third-party unlock rows (final review I-3, R27):** purging LIT's and PUMP's third_party
  `unlocks_next_year` rows (31 / 29 rows on the prod copy, 2026-10-16 .. deploy day) nulls dilution, and with it
  `yields.netShareholder`, `holderFlow.netOfDilution` and the per-token dilution, in every `report yield lit|pump --day
  <earlier day>` whose asOf (end of day + 1) is before the deploy-day refresh: about four weeks of history. The nightly
  and the snapshot after the deploy day are unaffected. Levels can't be backfilled, so the loss is permanent. Pick one:
  **(a)** purge now (spec D6; deploy.md step 8), accepting null past-day dilution for ~4 weeks, or **(b)** keep the
  third_party rows until R8 (nothing reads them for a day from the deploy day on).

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

Final re-review of c0e4750 (deploy.md release block wording; fix before release day, all fail-closed):
- N1 step 5 asks to confirm "source type disclosure, method disclosed", but `data show` prints `source` (`manual`) and
  `citationUrl`, not those fields: check `citationUrl` (x.com / blockworks) and the value instead.
- N2 step 4 lets a deferred smoke backfill wait; if it runs after `mid/` is saved, HYPE's step-9 `cmp` can STOP on a
  correct change: wait for the smoke backfill to finish (or skip it) before saving `mid/`.
- N3 the nightly warning overstates the mechanism, and the "re-save `mid/`" instruction sits only before step 7, not
  before a later step 8(a).
- N4 step 9's rationale holds only when the saved report day is the day before the deploy; step 8(b) cites
  `latest_levels` as the reason, but reports read observations.

## Carried to later releases

- **R3:** P5's two replacements: LIT's buyback `two_path` check (fills vs the treasury's LIT balance) and VVV's
  `usage_index` watch. Until R3, LIT's buyback and VVV's burn have no external check.
- **R2:** the price-history rebuild ships as a second op on this job kind (`backfill` with `op: prices`), not as a
  new verb or job kind.
- **Dead API cursor (Task 2 M-6):** a third_party purge of a still-configured metric (R1: LIT and PUMP
  `unlocks_next_year`, only if Mike picks (a)) leaves that metric's old API-flow cursor (`defillama:...>metric`) behind. Nothing reads it while
  the metric's source is no longer DefiLlama. Open: drop it (suggested: in R8 with the `defillama` source type).
- **Purge export files, per env:** each `data purge ... --yes` writes the rows it deletes, before deleting, to one
  file `~/home/purged/<asset>-<first metric>[+N]-<UTCstamp>.json` (`$ORION_HOME/purged/`, src/db/purge.ts) in that
  env user's home on venus: `/home/orion-stage/home/purged/` (stage), `/home/orion-prod/home/purged/` (prod). R1's
  release block writes four per env (one per orphan purge call: cake, lit, uni, vvv), plus two (lit, pump unlocks) if
  Mike picks (a). With the nightly `pg_dump` they
  are the only copy of the purged rows; nothing prunes them, and no verb reads them (Raymond sees only the path and
  sha256 the JSON output prints). Their retention is open (suggested: Mike copies them off venus after the purge;
  decide retention or a `purged list` verb with R8).
- **Open anomalies keyed to removed sources** (final review Minor 6): `cross_check_mismatch` / `source_failure_streak`
  anomalies deduped on coins.llama.fi, CoinGecko total_supply or the DefiLlama emissions stay open; only a manual
  resolve closes them (src/db/anomalies.ts). Suggested: a `data anomalies` sweep after the deploy, resolving each with
  "source removed in R1".

## Proof

Task 7, run by the controller on prod copy `p2proof_20261112t223129z` (120,316 rows / 21 tables, sums equal), D =
2026-11-11, old = orion-2026.11.11.1, new = 811d33f dist (+0007 applied); outputs in the controller's workspace
(`phase3-proof/r1/out/`), the copy dropped afterwards.
- Carry check: disclosed rows with an adapter locator = 0.
- AERO `cmp`-identical. crv, cvxcrv, hype, link, sdcrv, sky, ycrv: 0 differing paths.
- CAKE (9 paths) / UNI (6): only `incomeStatement.volume.*` (annualized -> null, notMeasured reason).
- PUMP: 16 dilution-derived paths at rel <= 1.3e-14 (float: 82500000000.00008 -> 82500000000).
- LIT: unlocks 138,796,789.02 -> 138,888,888.89 (+0.0664%); dilution-derived fields +0.066%; net-of-dilution fields
  +0.0729%; flags / provenance drop "holders.buyback.cross_checks". No revenue / holder flow / yield / price path moved;
  perTokenFdv revenue / grossProfit / holderFlow.total unchanged (the R22 check).
- VVV: the business line's crossCheck removed; `flags[3]`, `provenance.sources[2]` (`third_party:api.llama.fi`) and
  the thirdParty entries removed. Nothing else.
- Default report day old == new for all 13. The proof log was cut short after `sky` (by a `| head`); the controller's
  re-run gave uni 2026-11-11 / 2026-11-11, vvv 2026-11-11 / 2026-11-11, ycrv 2026-11-11 / 2026-11-11 (final review
  I-4), so removing UNI's `flow_usd.swap_fees` and VVV's `flow_usd.revenue_proxy` from the default-day metrics moved no
  day.
- New-home fetch: LIT unlocks 138888888.8888889, disclosure / disclosed, cited x.com; PUMP 82500000000, disclosure /
  disclosed, cited Blockworks.
- Purge rehearsal: dry-run counts = prod (cake 398 / 398, lit 191 / 191, uni 191, vvv 345, lit unlocks third_party 31,
  pump 29); `--yes` x6 exit 0; 6 export files; all 13 reports byte-identical before vs after the purge.
- Final flatdiff with the committed allowlist (ee295f6, and again after the final fix wave's value pins and bounds):
  all 12 exit 0 (cake 9/9, lit 20/20, pump 16/16, uni 6/6, vvv 8/8, the others 0 diffs); AERO `cmp`-identical.
- Deviations (recorded only): "before" came from the old release on the copy, not `ssh orion-prod report yield`
  (equivalent: both sides read the same data). Only window D was compared; the D-91 window was not run (it would have
  shown I-3's past-day dilution loss, now a gated decision). The PUMP Blockworks quote could not be checked verbatim
  offline.
