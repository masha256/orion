# Orion Phase 1.5b (Postgres, the SQLite importer, the row-for-row proof): followups (2026-11-04)

Spec `docs/superpowers/specs/2026-10-28-orion-platform-postgres-design.md` (rev 3). Plan
`docs/superpowers/plans/2026-10-29-orion-phase1.5b-postgres.md`. Ops doc `docs/ops/postgres.md`. Branch
`feat/platform-pg` was built in the durable worktree `/home/hermes/git/orion/.worktrees/platform-pg` by subagents, one
task at a time, each verified by the controller. It is not merged and not pushed. **It must not merge into `main`
before the cutover (§8.4).** The live install runs the SQLite `dist/` built from `main`, and this branch needs
Postgres. Plan 1.5c builds on this branch.

The SDD ledger was rebuilt by the controller on 2026-11-04, after the 24h scratch cleanup pruned the first worktree and
its git-ignored ledger. The commits were safe on the branch. This note copies the ledger's rulings and minors, so the
worktree's `.superpowers/` can go.

## Commits (base `dcc2c48` + spec commits; baseline 76 files / 905 tests, typecheck clean)

| Commit | Task |
|---|---|
| c07af6f | 1: async `Db` interface (all/one/run/tx, nested tx = savepoint) over a SQLite compat adapter; root-handle-in-tx guard |
| dedcb86 | 2: everything that reaches the database is async; the five raw transactions run in `db.tx` with an asset lock |
| 6d077ad, 97afed7, a94baf2 | 3-5: observations; fetch runs, cursors, anomalies; agent runs, journal, coverage, documents, proposals, run locks on the Db interface |
| d742367 | 6: every test opens its database through `tests/helpers/db.ts` (78 files / 912 tests) |
| a84762e | 7: pg pool with D7 type parsers, advisory locks (asset/run key spaces), `0001_baseline`, migrator, Postgres test setup (83 / 937) |
| a608d04 | 8: Orion runs on Postgres; `orion db migrate|status`; advisory run lock replaces `run_locks`; SQLite leaves `src/` (83 / 936) |
| 20dbfcc | 9: `tools/import-sqlite` import (one transaction, deferred FKs, sequences = `sqlite_sequence`, D8 + D3a carry rules, manifest) (84 / 950) |
| d189484 | 10: row-for-row proof (per-row sha256 through Orion's Db, sequences) and cross-release report comparison (85 / 956) |
| (this commit) | 11: `docs/ops/postgres.md`, README, this note; role-less URLs in the plan and spec corrected |

After Tasks 2 and 5, a byte-identity check ran on a `.backup` of live: `report yield --day 2026-10-30 --json` for all
13 assets was identical to `dcc2c48`, and so were `anomalies`, `proposals`, `inbox` and `agent runs list`.

## Proof on a copy of live (Task 11, run by the controller; ledger verbatim)

> Task 11 proof (controller, fresh .backup of live, sha256 957f21ed..., 34.8 MB, schema 8, integrity ok), into orion_dev schema proof_*:
>  - import 1.1 s, one tx. Carried == PG == manifest, per-row sha256 equal, first_mismatch none, for all 10 tables: agent_runs 64, agent_transcripts 1, coverage 13, documents 1, journal 59, proposals 2, observations 25,853, fetch_runs 408, fetch_cursors 55, anomalies 14.
>  - excluded: observations undeclared_metric 2,541 (all revenue_run_rate_usd; 2,481 at Phase-1 measurement + rows written until merge), agent_transcripts non_disclosure 63, proposals retired_kind 2; tables not carried: run_locks 0, config_versions 70 (P1), assumption_sets 34, assumptions 1137, assumption_changes 52, assumption_evidence 231, snapshots 391, valuation_runs 391, signals 391, trigger_firings 10.
>  - sequences: every table next id = sqlite_sequence+1 (observations 28,639).
>  - reports --day 2026-10-30: 15/15 byte-identical (13 report yield + anomalies + proposals), SQLite release dcc2c48 vs PG branch.
>  - ingest dry-run (live .env copy minus ORION_HOME, deleted after): 13/13 identical sorted sourceId:status + metric keys, 0 failed sources either side.
>  - first ingest-compare attempt had a broken reducer (empty == empty); discarded and rerun with raw JSON saved.
>  Scratch homes, .env copies and proof schemas deleted.

Per asset, the ingest dry-run (sources / written metric keys, identical on both releases, no failed source):
aero 6/8, cake 8/11, crv 9/18, cvxcrv 11/13, hype 9/9, link 7/12, lit 16/22, pump 8/12, sdcrv 14/16, sky 9/13,
uni 5/12, vvv 13/16, ycrv 8/10. Every `report-yield-<a>.json`, `anomalies.json` and `proposals.json` exited 0 on both
sides and was byte-identical. The raw `proof.json`, `reports.json` and `fetch.log` are in the git-ignored SDD folder.

Manifest notes:
- The plan expected about 2,481 `undeclared_metric` rows. There were 2,541: the 2,481 measured at Phase 1, plus the
  `revenue_run_rate_usd` rows the live install kept writing until Phase 1 merged. All 2,541 are
  `revenue_run_rate_usd`, so no dominance rows were left in the snapshot.
- 2 proposals were excluded as `retired_kind` (`assumption_value`). The brief expected Phase 1 D5's #1 (VVV) and
  #4 (CAKE); the ids were not re-checked in this note.
- The brief expected 48 `non_disclosure_transcript` exclusions. The snapshot excluded 63: of its 64 agent runs, only
  the one disclosure run's transcript is carried. The 63 runs themselves are carried and show the transcript as null.
  The gap from 48 was not investigated.

The count grows until the cutover, so 1.5c's cutover re-runs this proof on its own snapshot.

## Measured scope (main `dcc2c48`, post-Phase-1; `git grep` on 2026-10-29; from the plan)

| | spec §1 (pre-Phase-1) | measured |
|---|---|---|
| `src/db/` | 16 files, 1,852 lines | 12 files, 1,544 lines (10 query modules 1,128; `migrations.ts` 378; `connection.ts` 38) |
| exported db functions | 51 | 47, of which 40 run SQL (the other 7: `migrate`, `openDb` and 5 pure helpers) |
| `src/` outside `src/db/` with a DB handle or DB call | 40 files, 5,864 lines, 116 calls | 23 files, 4,019 lines, 99 call sites of the 40 (plus 15 inside `src/db/`) |
| sync functions taking `db` outside `src/db/` | (not measured) | 21, plus 9 agent tool `run` handlers, `runTool`, `Ledger.commit`, `withDb` (10 CLI command files) |
| raw `prepare/exec/transaction/pragma` | 61 (all but 7 inside `src/db/`) | 66 inside `src/db/` (52 statements); 5 outside: `agent/ledger.ts:221`, `app/proposals.ts:68`, `ingest/apiFlow.ts:192`, `ingest/flow.ts:323`, `ingest/periodic.ts:70` |
| transactions inside `src/db/` | — | 4: `insertObservation`, `raiseAnomaly`, `finishAgentRun` (immediate), `acquireRunLock` (immediate) |
| `tests/` touching a DB | 57 files, 11,387 lines, 553 calls | 47 test files + 2 helpers, 9,116 lines, 485 call sites; ~885 test cases in 76 files |
| `openDb(` in tests | 45 files | 45 calls in 35 files (26 with `':memory:'`, 9 with a temp file) |
| raw better-sqlite3 calls in tests | 113 (67 in `connection.test.ts`) | 104 (70 in `tests/db/connection.test.ts`, 34 in 14 files) |
| dialect sites | 10 `lastInsertRowid`, 10 `.changes`, 2 `INSERT OR IGNORE`, 4 `excluded.` | 7 `lastInsertRowid`, 3 `.changes`, 0 `INSERT OR IGNORE`, 4 `ON CONFLICT` (3 with `excluded.`), 7 `.immediate()`, 1 `.iterate()`, 1 `IN (?,…)`, 1 `EXISTS … AS superseded` compared `=== 1` |

Live row figures at the Task 11 snapshot are in the proof section above. They supersede the spec's §1 counts. For
example, the observations sequence was at 28,638, not 27,447.

## Spec corrections (post-Phase-1 code vs the spec; from the plan, as built)

1. `journal` is live (disclosure runs write it), so it is in the baseline and carried in full, not dropped.
2. `config_versions` has no reader or writer after Phase 1: decision P1 (below).
3. `run_locks` was still live (`withRunLock` for `tick` and `agent run`). It is replaced by the session advisory lock,
   which keeps the orphan-abandonment rule and the holder name. The table is dropped.
4. Undeclared metrics are not carried (Phase 1 D3a). The sequence still continues at `sqlite_sequence`, and the
   excluded ids are in the manifest.
5. `documents.published_at` stays `text`, because `timestamptz` would rewrite `…:00Z` as `…:00.000Z` and turn a date
   into a midnight instant.
6. `observations.superseded_by` points forward, so the FK is `DEFERRABLE INITIALLY IMMEDIATE` and the importer runs
   `SET CONSTRAINTS ALL DEFERRED`.
7. One advisory key for both locks would deadlock. There are two key spaces: `run` for the session lock, held on a
   dedicated non-pool connection, and `asset` for the transaction lock.
8. No CLI test spawns a subprocess. The database reaches CLI tests through `CliContext.database`.
9. The dialect inventory is the measured table above (the `EXISTS` boolean in `listDocuments` was missed; `INSERT OR
   IGNORE` no longer exists).
10. Importer seeding of `asset_registry` (§8.1) moves to 1.5c with the table (migration `0002`).
11. `tsc` does not emit `.sql`: `npm run build` copies `src/db/pg/migrations/` into `dist/`.
12. Phase 1's stored-`assumption_value` tests became "the database refuses it". The inbox case moved to a stored
    `config` proposal with an old effect.

Found during the build, beyond the plan:

13. Advisory-lock keys include the schema (R-b10).
14. Postgres URLs must name the role (R-b9). The spec's §4 table and the plan's test command gave the role-less form;
    both are corrected in this commit.

## P1 `config_versions`: decided, not carried (Mike, 2026-11-04)

Option (a): its 70 rows stay in the archived SQLite file with the other valuation-era tables. There is no
`config_versions` in `0001_baseline`, and the importer lists it under `TABLES_NOT_CARRIED`. The 1.5c registry keeps
its own `config_hash`. If it is ever wanted back: one `CREATE TABLE` in a new expand-only migration, plus a carry
entry, imported from the archived file.

## Rulings (binding during the build) and what each costs if wrong

The rebuilt ledger holds R-b3 to R-b5 and R-b7 to R-b12. **R-b1, R-b2 and R-b6 were in the pruned original ledger and
could not be recovered.** They are not reconstructed here from memory. If they matter, the Task 1-5 review threads are
the only remaining source.

| Ruling | What it says | Cost if wrong |
|---|---|---|
| R-b3 | Sequential awaits only inside `db.tx`; never `Promise.all` on a tx handle | Too strict only costs latency inside transactions (no network I/O there, so small). If relaxed, savepoint names collide and an outer-`db` call inside a tx deadlocks a pool of 1 |
| R-b4 | `close()` is async and awaited | An unawaited close leaks a pool connection per CLI command and lets the process exit with queries in flight. The cost of the ruling is one `await` per caller |
| R-b5 | `concurrency.test.ts`'s interleaving helper wraps the tx handle, for setup only | If the wrapper leaked into assertions, the test would prove the helper rather than the code. Test-only, so no production cost |
| R-b7 | `tests/db/compat.test.ts` stays on raw `openDb` and was deleted with `sqliteCompat.ts` in Task 8 | None now: both are gone. If wrong, Tasks 1-7 ran the compat layer untested through the helper |
| R-b8 | `useTestDb.reset()` on Postgres = `TRUNCATE … RESTART IDENTITY` of every table | Ids restart at 1 in every test, as on a fresh SQLite file. A test that needs ids to continue across tests would pass for the wrong reason. The alternative (a schema per test) costs a migrate per test |
| R-b9 | Postgres URLs name the role (`orion_dev@`, `orion_prod@`, `orion_stage@`) | None if followed. A role-less URL fails at connect (peer auth as the OS user, rejected by `pg_hba`). The env.template example is still role-less (open items) |
| R-b10 | Advisory-lock key = `sha256('orion:<schema>:<space>:<id>')` | Two schemas in one database never block each other. That is wanted for parallel test files and scratch schemas. It would be wrong only if two environments ever shared one schema name in one database, and prod and staging are separate databases. A schema rename while a run holds the lock would let a second run in, so no rename during a run |
| R-b11 | The test globalSetup sets `ALTER DATABASE … SET synchronous_commit = off` only on a database whose name ends in `_test`, and refuses any other, before setting anything | If the guard were absent, a mis-set `ORION_TEST_DATABASE_URL` pointing at prod would turn off durable commits there. The cost of the ruling: tests can't run on a database not named `*_test` |
| R-b12 | Dead `assumption_value` code paths in `src` are removed if trivial (done in Task 9: the union member, the `proposal_kind_retired` branch, the CLI formatter, `SCENARIOS`) | None while the CHECK refuses the kind. If a valuation layer returns, the kind comes back as new code and a migration, not by reviving these paths |

Carry items handed from the Task 1-5 review into Tasks 7-9 (all done; details in the task reports):
- (a) A nested `lockAsset` on another asset is refused (`tx_asset_mismatch`, in the pool).
- (b) `evidenceLookup` reads only shown ids and refuses more than 200.
- (c) RAISE triggers became plpgsql.
- (d) The disclosure e2e `beforeAll` seed was verified.
- (e) `npm run lint:promises` (oxlint `--type-aware`, ~1 s).
- (f) `SUM`/`AVG` casts, guarded by `tests/meta/aggregates.test.ts`.
- (g) The awaits meta test is recursive over `src/db` and `tools/`.
- (h) The `orion_dev@` URL form is in the docs (this commit).

## Review minors (deferred)

- The Task 1-5 review counted 6 minors. Their text was in the pruned ledger and is not recoverable. The four named
  risks (floating promises, tx-handle misuse, SQL/order drift, error semantics) were reviewed CLEAN.
- A `connectionString` that carries its own `options=` would override the pool's `search_path`/`TimeZone` options. That
  is not an issue for the documented URLs (Task 7).
- `application_name` is truncated at 63 bytes, so run-lock holder strings must stay short (Task 7).
- The run-lock `since` is the lock connection's `backend_start`, i.e. roughly the acquire time (Task 7).
- `openDb` refuses only `pending` migrations. A `changed` applied file with nothing pending opens fine, and only
  `db status`/`migrate` report it (Task 8).
- `withDb` opens a pool per command plus one `migrationStatus` read. Negligible for the CLI, but 1.5c's daemon should
  hold one pool (Task 8).
- `tsc` does not clean `dist/`, and stale `migrations.js`, `runLocks.js` and `sqliteCompat.js` lingered. A deploy must
  build into a clean `dist/` (Task 8).
- The lockfile gained ~500 lines of optional oxlint platform binaries. npm warned that esbuild's install script was
  skipped under its install-scripts policy, which is harmless here (Task 8).
- The R-b11 test connects to database `postgres` as `orion_dev`. If `pg_hba` ever denies that, the test fails with a
  connect error (Tasks 9-10).
- The manifest lists every excluded id (~2.5k), and `source.path` is absolute (Tasks 9-10).
- `--to <url>` is visible in `ps`. That is harmless with peer auth and no password (Tasks 9-10).
- `proof` does not compare the manifest's `source.sha256` with `--from`. A different snapshot shows as row mismatches
  (Tasks 9-10).
- `docs/ops/hermes-daily-job.md` still describes the SQLite live install ("the first `orion` command after a deploy
  applies any pending migration", `orion.db`). That is correct for `main` today, and the cutover (1.5c) rewrites it
  for `orion db migrate`.

## Open items

1. **Do not merge `feat/platform-pg` into `main` before the cutover (§8.4).** 1.5c branches from it. The cutover
   re-runs the import and the proof on a fresh snapshot.
2. **`scripts/provision/files/env.template` (on `main`): its `ORION_DATABASE_URL` example
   `postgresql:///@DB@?host=/var/run/postgresql` names no role and fails.** It must become
   `postgresql://@DB@@/@DB@?host=/var/run/postgresql` (role = database name: `orion_prod`, `orion_stage`). Fix it in
   provisioning on `main`, because this branch does not carry `scripts/provision/`. Any venus `.env` already filled from it
   needs the same check by hand, since the script never overwrites that file.
3. **Test globalSetup `synchronous_commit` guard.** R-b11's guard is by database name only (`*_test`). If someone
   names a non-test database `*_test`, the setting lands there. Decide in 1.5c whether to also require that the
   database owner is `orion_dev`, or to move the setting to `SET synchronous_commit` per test session, which persists
   nothing.
4. R-b1, R-b2, R-b6 and the six Task 1-5 review minors are lost with the pruned ledger (above).
5. The plan named this note `…-phase1.5b-followups.md`. The file is `…-phase1.5b-postgres-followups.md`, and the plan's
   file list now points here.
