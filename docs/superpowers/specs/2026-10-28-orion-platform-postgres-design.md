# Orion Phase 1.5: platform (environments, deploy, Postgres)

Status: draft for review (2026-10-28, kanban t_269c7cc5). Umbrella: `2026-10-28-orion-coinrevs-core-roadmap.md`
(branch `feat/coinrevs-core` @ e666b87), decisions 8 and 9. Assumes Phase 1 (`2026-10-28-orion-phase1-remove-valuation-design.md`)
has landed: no engine, signals, assumptions, journal or trigger firings; `tick` = lock, ingest, anomalies, report.

Fixed by Mike (not re-argued here): prod Postgres = DigitalOcean (DO) managed; one DO droplet for the prod website, one for
Orion with two Unix users (prod, staging), each with the same layout under its home, its own `.env`, schedule, database and
role, and the staging role has no rights on the prod database; dev stays on this host with a local Postgres; Raymond deploys
over SSH from this host (no SSH key exists here yet).

Nothing in this spec has been installed or provisioned. Every figure marked *measured* was read on 2026-10-28 from main
34a9f9d and the live `orion.db` (read-only); prices were read from DO's public pricing pages the same day.

## 1. Survey (what exists today)

**Runtime path.** Hermes cron (raymond profile) runs 13 agent jobs `orion-<asset>` at 05:05-06:05 PT, 5 min apart. Each has a
pre-run script `scripts/orion-tick-<asset>.sh` → `orion-tick.sh <asset>`, which sources `/home/hermes/git/orion/.env`, runs
`run-daily.sh <asset>` (→ `node dist/cli/index.js tick <asset>`, stderr appended to `tick.log`), retries once on exit 1
(10 min) or `run_in_progress` (30 min), and frames each attempt for the agent. The agent (a ~13k-character prompt per job)
formats the tick report into the #orion-ops message and later runs the decision verbs Mike replies with (confirm, reject,
approve, decline, ack, resolve). A 14th job, `orion-disclosure-watch` (09:40 PT, `no_agent`), runs a Python watcher that
lives outside the repo (`~/.hermes/profiles/raymond/workspace/orion/disclosure-watcher/`, 1,274 lines; needs `yt-dlp`,
`ffmpeg`, `faster-whisper` `small.en`, PyYAML) and calls the Orion CLI. Phase 1 rewrites the 13 prompts but keeps Hermes cron.

**DB layer.** `better-sqlite3`, synchronous. `src/db/` = 16 files, 1,852 lines; `openDb` sets WAL, `foreign_keys = ON`,
`busy_timeout`, and applies migrations on every open. 8 migrations; 5, 7 and 8 rebuild tables because SQLite cannot alter a
CHECK (they copy `sqlite_sequence` by hand).

**Live data (measured).** 28.2 MB file, schema 8. Rows kept after Phase 1: observations 27,447 (4,241 superseded; sources
onchain 20,340 / api 7,083 / manual 24), fetch_runs 329 (~10.6/day, avg 2.9 kB `detail_json`), fetch_cursors 55, anomalies 11,
config_versions 70, coverage 13, documents 1, proposals 4, agent_runs 49, agent_transcripts 49 (10.8 MB, of which the one
disclosure run is 0.24 MB), run_locks 0. Every timestamp is 24-char ISO UTC with milliseconds (`...T..:..:..sssZ`; 0
exceptions in observations). Every `value` is REAL; every `detail_json` is valid JSON. Largest block cursor 130,181,609.

**Conversion scope (measured on main, before Phase 1 removes its slice; the plan re-measures after it).**

| | files | lines | calls to the 51 exported db functions | raw `db.prepare/exec/transaction/pragma` |
|---|---|---|---|---|
| `src/` touching a `Db` | 40 | 5,864 | 116 | 61 (all but 7 inside `src/db/`) |
| `tests/` touching a `Db` | 57 | 11,387 | 553 | 113 (67 in `tests/db/connection.test.ts`) |

Raw transactions outside `src/db/`: `ingest/flow.ts:321`, `ingest/periodic.ts:70`, `ingest/apiFlow.ts:190`,
`app/proposals.ts:66`, `agent/ledger.ts:271` (plus `app/triggers.ts`, `app/valuation.ts`, removed in Phase 1). Ingest is
already async (network), so most callers above the DB already `await`; the new `async` surfaces are `report/load.ts`, the
`app/` and CLI command bodies, the agent context/tools/ledger used by disclosure runs, and every test.

**SQLite-specific code to replace.** `lastInsertRowid` (10 sites) → `RETURNING id`; `.changes` (10) → `rowCount`;
`INSERT OR IGNORE` (`runs.ts` config_versions; `assumptionChanges.ts` goes in Phase 1) → `ON CONFLICT DO NOTHING`;
`ON CONFLICT ... excluded.` (4, valid in Postgres as written); `.iterate()` in `fetchRuns.recentSourceStatuses` (scans every
fetch run of an asset in JS) → one SQL query over `json_array_elements(detail_json->'sources')`; `.immediate()` transactions
(run lock, periodic and API-flow writes, ledger) → the locking rule in §6.3; `IN (?,?,...)` → `= ANY($1)`; `?` → `$n`;
`pragma` calls and `sqlite_sequence` go. No `datetime()`/`strftime()`/`json_extract` in `src/` (the only `json_extract` use is
in the skill's diagnostic queries, which get Postgres equivalents in the ops doc).

**Test fixtures.** 45 test files open `':memory:'` or file DBs through `openDb`; `tests/helpers/{fetchHarness,agentWorld}.ts`
build most of them; `tests/db/connection.test.ts` tests SQLite migration mechanics directly (retired with them);
`tests/agent/concurrency.test.ts` and `tests/db/runLocks.test.ts` open two connections to one file to race the run lock;
`tests/cli/{cli,tick.cli,agent.cli}.test.ts` spawn the CLI against a temp `ORION_HOME`.

## 2. Environments and Unix users

| env | host | Unix user | `ORION_HOME` | DB / role | schedule | posts to |
|---|---|---|---|---|---|---|
| dev | this host | `hermes` | worktree or scratch dir | local Postgres: `orion_dev`, tests in `orion_test` | none (by hand) | nowhere |
| staging | Orion droplet | `orion-stage` | `~orion-stage/home` | `orion_stage` / role `orion_stage` | own timers, offset +2h | #orion-staging (decision D3) |
| prod | Orion droplet | `orion-prod` | `~orion-prod/home` | `orion_prod` / role `orion_prod` | own timers | #orion-ops |

Same layout under each home (only the user differs):

```
~/releases/<tag>/        immutable: dist/, assets/, scripts/, package.json, package-lock.json, node_modules/ (prod deps)
~/current -> releases/<tag>
~/shared/.env            mode 600, never in a release (§4)
~/shared/do-ca.crt       DO cluster CA, for sslmode=verify-full
~/home/                  ORION_HOME: ticks.jsonl, tick.log, disclosure watcher state/ and transcripts/
~/bin/orion-remote       forced-command entry point for SSH (§3.4); installed by provisioning, not by releases
~/deploys.log            one line per install / switch / rollback
```

The website droplet runs no Orion code; it reads prod through the read-only role (§9). The dev host stops being production
at cutover (§8.4): `/home/hermes/git/orion` becomes a plain dev checkout, and the live-install rules in the `orion` skill move
to the droplet.

Node: the same major on all three (pinned in `.nvmrc` and `engines`), installed system-wide under `/opt/node-v<major>` by
provisioning. Postgres client tools (`pg_dump`, `pg_restore`, `psql`) of the cluster's major on the droplet and the dev host.

## 3. Release and deploy

### 3.1 Releases
- A release is an annotated git tag on `main`, pushed to GitHub: `orion-YYYY.MM.DD.N` (date of cut, N from 1). Tags are
  never moved; a fix is a new tag.
- `scripts/release/build.sh <tag>` (dev host): `git worktree add --detach` the tag in `$TMPDIR`, `npm ci`, `npm run build`,
  full suite + typecheck against the local test Postgres, then pack `dist/ assets/ scripts/ package.json
  package-lock.json` (no `src/`, `tests/`, `.env`, DB files) into `orion-<tag>.tgz` with a `RELEASE` file (tag, commit sha,
  schema version the code requires, build time) and a `.sha256`. A red suite stops the build; there is no skip flag.

### 3.2 Deploy
`scripts/release/deploy.sh <stage|prod> <tag>` (dev host, one SSH key per env, §3.4):
1. Refuse unless the tarball's commit is reachable from `origin/main` and the tag exists on GitHub.
2. **prod only:** refuse unless the same tag is `current` on staging and staging has completed at least one scheduled
   daily run on it with no failed source that prod didn't also fail (read from staging's `ticks.jsonl` via `orion-remote
   status`). Override `--no-soak` exists for a hotfix and is printed in the report (decision D5).
3. `scp` the tarball + sha; remote `orion-remote install <tag>`: verify sha, unpack to `releases/<tag>`,
   `npm ci --omit=dev --ignore-scripts` (the runtime deps are pure JS once `better-sqlite3` is gone), `orion asset validate`
   for every asset, `orion db status` (pending migrations listed, nothing applied yet).
4. Remote `orion-remote switch <tag>`: take the environment's run lock file (`flock ~/home/.orion.lock`, the same one the
   timers hold, so a deploy never lands mid-tick; waits up to 30 min, then refuses), `orion db migrate` with the new
   release, atomically repoint `current` (`ln -sfn` to a temp name + `mv -T`), append to `deploys.log`, release the lock.
5. Print the before/after tag, migrations applied, and the next timer firing. Raymond reports this verbatim.

Assets live in the release (`assets/*.yaml`), so a YAML change is a release. That breaks today's
`model proposals approve <id>` for `config` proposals, which edits `assets/<a>.yaml` in place (decision D6).

### 3.3 Migrations and rollback
- New migration series in `src/db/pg/migrations/NNNN_<name>.sql`, starting at `0001_baseline` (the post-Phase-1 schema of
  §6.1). The SQLite migrations 1-8 leave the code; they stay in git history and in the archived file.
- `schema_migrations (id, name, sha256, applied_at)`: a migration file whose hash differs from the applied row is refused.
- Migrations run only in the deploy's `switch` step (`orion db migrate`), never on open. On open the CLI checks
  `max(id) >= RELEASE.schema`: older schema → refuse ("run orion db migrate"); newer schema → run (§ rollback).
- **Rollback** = `deploy.sh <env> --rollback` repoints `current` to the previous release; no data change. That only works if
  the previous release runs on the newer schema, so migrations are **expand-only** by rule (add tables, columns with
  defaults, indexes, widen a CHECK). A migration that drops or rewrites data is marked `-- breaking` in its first line; the
  deploy then requires `--breaking`, takes a `pg_dump` into `~/shared/predeploy/` first, and rollback past it means
  restoring that dump (or PITR, §10). Breaking migrations get their own release with nothing else in it.

### 3.4 SSH access
- Two ed25519 keys on this host, created at provisioning with Mike's go: `~/.ssh/orion-stage_ed25519`,
  `~/.ssh/orion-prod_ed25519`. Each is installed only in its own user's `authorized_keys`, with
  `restrict,command="~/bin/orion-remote"`. A leaked dev-host key then can run only the wrapper's verbs, never a shell, and
  cannot read `.env`.
- `orion-remote` verbs: `install <tag>`, `switch <tag>`, `rollback`, `status`, `logs [n]`, the read-only Orion commands
  (`report`, `data anomalies/sources/show`, `proposals list`, `agent runs list`), the six decision verbs (§5.3), `sql-ro
  <query>` through the read-only diagnostics role (§9), and `refresh-staging` (stage only). Anything else is refused and
  logged. Arguments are passed as argv (no shell expansion), notes quoted as one argument.
- Mike keeps an admin key (his own) with sudo on the droplet; provisioning and `.env` edits are his (decision D4).
- `known_hosts` pinned at provisioning; SSH inbound on the droplet only from this host's IP and Mike's (DO cloud firewall).

## 4. Secrets

`~/shared/.env` per user, mode 600, owner the env's user; read by Orion's `loadEnv` (no sourcing needed by wrappers).

| key | prod | staging | dev |
|---|---|---|---|
| `ORION_DATABASE_URL` | `orion_prod` role, `sslmode=verify-full`, VPC host | `orion_stage` role | local socket |
| `ORION_ETH_RPC_URL`, `ORION_BASE_RPC_URL`, other RPCs | prod Alchemy app | a separate Alchemy app (own quota, own key) | Mike's current key |
| `COINGECKO_API_KEY` | Basic plan key (roadmap decision 3) | none (keyless spacing) unless Basic terms allow a second env | none |
| `ANTHROPIC_API_KEY` | disclosure runs only | none: staging watcher runs `--dry-run` | as today |
| `SLACK_WEBHOOK_URL` | #orion-ops webhook | #orion-staging webhook | none |

Rules: never in a release, a tarball, a log or `deploys.log`; `orion-remote` has no verb that prints `.env`; the deploy never
copies or edits it. Rotation: Mike edits the file over his admin key; Orion reads it per process, so the next run uses it.
`ORION_HOME` is not in `.env` (the unit files set it), which removes today's scratch-shell trap of a copied `.env`
re-pointing commands at production.

## 5. Schedule and Slack

### 5.1 Timers
systemd **user** timers per environment (`loginctl enable-linger` for both users at provisioning), not crontab:
`OnCalendar=` takes a timezone (`*-*-* 05:05:00 America/Los_Angeles`, so DST is handled), `Persistent=true` catches a run
missed while the droplet was down, logs go to the journal, and `OnFailure=` can post a failure.

| unit | prod | staging |
|---|---|---|
| `orion-daily.timer` → `run-all.sh` | 05:05 PT | 07:05 PT |
| `orion-disclosure.timer` → watcher | 09:40 PT | 11:40 PT, `--dry-run` |
| `orion-dump.timer` (§10) | 02:30 PT daily | none |
| `orion-refresh.timer` (§8.5) | none | Sun 03:30 PT |

`run-all.sh` replaces the 13 cron jobs and 13 wrapper scripts: it holds `~/home/.orion.lock` and runs a new `orion tick
--all`, which ticks every asset in `assets/*.yaml` one after another in **one** process (CoinGecko's keyless spacing is
per process, so 13 separate `tick` processes back to back would be throttled), applies today's retry rule per asset
(exit 1: one retry after the loop, at least 10 min later; `run_in_progress` no longer exists after Phase 1), then posts
(§5.2). Adding an asset becomes config only. 13 ticks in a row take ~3-5 min (measured: fetch runs since 10-20 have a
median of 10 s, p90 32 s, max 58 s); the 5-minute spacing only existed to keep Hermes jobs apart.

### 5.2 Getting reports to #orion-ops (decision D2)
After Phase 1 the report needs no model: it is formatting of `ticks.jsonl` (watch lines, failed sources, anomalies, a
holder-yield block).

- **A. Orion posts itself (recommended).** New `orion notify slack --run <id>` formats the run's tick reports
  deterministically (the Phase 1 message format, the same ALERT rules) and posts to an incoming webhook from `.env`.
  Silence still means broken, guarded twice: `OnFailure=` posts "ORION ALERT <env>: daily run failed (exit n)", and a
  Hermes `no_agent` job on this host at 07:00 PT calls `orion-remote status` and posts "ORION SILENT" if prod has no
  completed run since 04:00 PT (catches a dead droplet or a broken webhook). Cost: no Anthropic spend for reports (today 13
  agent sessions a day). Loses: replying in the #orion-ops thread to run a decision.
- **B. Droplet runs, Hermes posts.** Timers run ticks on the droplet; 13 Hermes jobs on this host pull each report over SSH
  and keep today's agent message and thread decisions. Keeps the reply flow, but reports depend on this host being up,
  and it keeps the per-asset agent spend and Hermes on the critical path that decision 9 is moving off.
- **C. Hermes cron triggers ticks over SSH.** Scheduling stays in Hermes; contradicts the roadmap. Not recommended.

### 5.3 Decisions after A
Mike replies in #orion-dev (or any Raymond thread): "ack 7 <note>". Raymond runs `ssh orion-prod orion-remote ack 7
'<note>'` and posts Orion's JSON result. The verbs and refusal rules are today's prompt rules, enforced by `orion-remote`
(only the six verbs; ids must exist and be pending; notes passed as one argv). Config proposals follow decision D6.

## 6. Postgres schema and the async conversion

### 6.1 Schema (`0001_baseline`), post-Phase-1 tables only
One schema `orion` per database, owned by the env role. Type mapping:

| SQLite | Postgres | why |
|---|---|---|
| `INTEGER PRIMARY KEY AUTOINCREMENT` | `bigint GENERATED BY DEFAULT AS IDENTITY` | BY DEFAULT so the import keeps ids; sequence set to SQLite's `sqlite_sequence` value |
| `REAL` | `double precision` | both IEEE 754 double; Postgres ≥12 prints the shortest exact form, so values round-trip bit-for-bit |
| ISO-text timestamps | `timestamptz` (decision D7) | the site and ops can do date arithmetic; read back as the same 24-char ISO string (§6.2) |
| `fetch_cursors.last_day` text | `date` | read back as the raw `YYYY-MM-DD` string |
| `*_json` text | `json` (not `jsonb`) | validated and queryable (`->`, `->>`), but stored byte-for-byte, so the row proof can compare text and key order never changes |
| other `TEXT` | `text COLLATE "C"` | byte-order sorting as in SQLite; a DO database's default locale would reorder `ORDER BY metric_key` and could move report output |
| `INTEGER` flags (`dry_run`) | `smallint CHECK (dry_run IN (0,1))` | no code change; a boolean is not worth the diff |
| block numbers, counts | `bigint` | |

Tables: `observations`, `fetch_runs`, `fetch_cursors`, `anomalies` (with the partial unique index `WHERE status = 'open'`),
`documents`, `proposals` (CHECK without `assumption_value`), `coverage`, `run_locks`, `config_versions`, `agent_runs`
(CHECK keeps the historical run types so history imports; the code creates only `disclosure`), `agent_transcripts`,
`schema_migrations`. Same columns and indexes as SQLite after migration 8, plus `idx_obs_metric_day (asset_id, metric_key,
observed_at DESC) WHERE superseded_by IS NULL AND status <> 'rejected'` (the report's main read). Foreign keys are real and
always on (Orion's SQLite connection turns them on too; only the `sqlite3` shell runs without them, which is why
today's hand repairs delete children first. In Postgres a wrong-order delete is refused instead).

Not carried: `assumption_sets`, `assumptions`, `assumption_changes`, `assumption_evidence`, `snapshots`, `valuation_runs`,
`signals`, `journal`, `trigger_firings`, transcripts of non-disclosure runs, and `assumption_value` proposals (decision D8).
They stay in the archived SQLite file (§8.4).

### 6.2 Driver: `pg` (node-postgres) with a pool
- Chosen over `postgres` (porsager) and query builders (Kysely, Drizzle): it keeps every query as written SQL with `$n`
  placeholders (smallest diff, easiest review), gives per-type parsers, and works behind DO's PgBouncer in transaction mode
  (no named prepared statements are used).
- Type parsers set once in `src/db/connection.ts`: int8 → `Number` (throws above 2^53), timestamptz → `new
  Date(v).toISOString()`, date → raw string, json → raw string (callers already `JSON.parse`). Then every `fromRow` stays
  as it is and every value the code sees is the same type and text as today.
- `Db` becomes a small interface the rest of the code uses: `all(sql, params)`, `one`, `run` (→ `{rowCount, rows}`),
  `tx(fn, {lockAsset?})`. A `tx` handle is itself a `Db`, and a nested `tx` is a SAVEPOINT (better-sqlite3 nests the same
  way, and `ledger.commit` → `insertObservation` relies on it).

### 6.3 Concurrency
SQLite serialised all writers; `.immediate()` guarded the read-then-write paths. Postgres runs `READ COMMITTED` concurrently,
so every write transaction that reads first takes `pg_advisory_xact_lock(<asset key>)` (a 64-bit key from
sha256('orion:asset:'+id), computed in JS) through `tx(fn, {lockAsset})`. That reproduces SQLite's serialisation per asset,
which is all Orion needs. The run lock becomes one atomic statement: `INSERT ... ON CONFLICT (asset_id) DO UPDATE ...
WHERE run_locks.expires_at <= $now RETURNING ...` (no row back = held, with the holder read after).

### 6.4 Conversion plan (sizes from §1)
1. `src/db/` rewritten (12 kept modules; ~1.3k lines after Phase 1), `connection.ts` = pool + parsers + `tx`.
2. Callers: `async`/`await` through ~35-40 `src/` files. Mechanical except the 5 raw transactions, which move into `tx`
   with an asset lock, and `recentSourceStatuses`, which becomes SQL.
3. A guard against a classic async bug: a function inside a transaction calling the pool instead of its `tx` handle runs
   outside the transaction. The test suite runs with pool `max: 1`, so any such call deadlocks and fails on the test
   timeout instead of passing silently.
4. `better-sqlite3` leaves `dependencies`; it stays a devDependency only for the one-off importer (§8).

### 6.5 Test strategy
- Real Postgres for every test (decision D9): the same major as the DO cluster, local on this host. A vitest
  `globalSetup` creates `orion_test` once; each test file gets a fresh schema `t_<random>` (migrations applied, ~50 ms),
  dropped in `afterAll`; tests that used `':memory:'` per test get a `TRUNCATE ... RESTART IDENTITY` between tests. No mocks
  of the DB.
- `ORION_TEST_DATABASE_URL` unset → the suite fails loudly (no silent skip).
- The run-lock race tests use two pool clients. CLI subprocess tests pass the URL and schema via env. `connection.test.ts`
  (SQLite migration mechanics) is replaced by migration tests: baseline applies, hash mismatch refused, older-schema
  refusal, rollback compatibility (release N-1 test pass on schema N, run in CI for every migration).
- The alternative, PGlite (in-process WASM Postgres), is faster and needs no install, but it is one connection, so the
  concurrency tests can't run on it, and it is not the server prod runs.

## 7. Phase 1.5 work order (for the plan)
1. Dev Postgres on this host (needs Mike: `apt install postgresql-<major>` needs sudo, D10).
2. Branch `feat/platform-pg`: §6 code, tests green on local Postgres; importer (§8.1); `run-all.sh`, `notify slack`,
   `orion-remote`, release scripts, systemd units, provisioning scripts (`scripts/provision/{orion-host.sh,pg-roles.sql}`)
   written but not run.
3. Proofs on dev (§8.2-8.3) against a `.backup` copy of live SQLite.
4. Mike provisions (DO console + the two scripts, D4); Raymond creates the SSH keys on his go.
5. Staging: deploy, import, then a parallel run of ≥3 days next to the still-live SQLite install (§8.3).
6. Prod cutover (§8.4); Hermes `orion-<asset>` jobs removed; disclosure watcher moved into the repo and onto prod timers
   (D11); `orion` skill and `docs/ops/` rewritten for the droplet.

## 8. Data migration from SQLite

### 8.1 Importer
`node tools/import-sqlite.js --from <sqlite .backup> --to $ORION_DATABASE_URL` (dev-only tool, not in releases): refuses a
target with any rows; copies the carried tables in FK order inside one transaction; sets each identity sequence to the
`sqlite_sequence` value (e.g. observations 27,447) so new ids continue exactly where SQLite stopped; writes an import
manifest (source file sha256, schema id 8, per-table counts carried and excluded, excluded ids) to stdout and to
`~/home/import-<stamp>.json`. 28 MB imports in seconds, so a full re-import is cheaper than any incremental scheme.

### 8.2 Row-for-row proof
1. **Counts:** per carried table, SQLite count = Postgres count; excluded rows listed by table and reason (counts must match
   the manifest).
2. **Row hashes:** one normaliser used on both sides: each row's columns in schema order, timestamps as 24-char ISO,
   doubles via `Object.is`-exact JS numbers (shortest repr), json and text as exact strings, null as null → sha256 per row,
   then per table over rows ordered by primary key. SQLite read with better-sqlite3, Postgres read through Orion's own `Db`
   (so the type parsers are part of what is proved). Any mismatch prints the first differing row and column.
3. **Sequences:** next id per table = SQLite's `sqlite_sequence` + 1.
4. **Reports:** `report yield <a> --day <fixed> --json` for all 13 assets, SQLite release vs Postgres release on the same
   imported data; `cmp` each pair; must be identical. Plus `data anomalies --all --json` and `proposals list --json`.
5. **Ingest:** `data fetch <a> --dry-run --json` with both releases at the same moment; differences only in fetch timing.

### 8.3 Parallel run on staging
For ≥3 days staging (Postgres, its own fetches) and the live SQLite install fetch the same chains. A daily diff of each
day's new observations (asset, metric, observed_at, value, source) must be empty apart from rows the sources revised between
the two fetch times (listed with both values). That proves the Postgres release ingests identically, not only that it reads
identically.

### 8.4 Cutover (live-install rules apply; Mike's go)
Pause the 13 Hermes jobs and the watcher; check nothing is mid-run; `.backup` + `integrity_check`; import into
`orion_prod`; rerun §8.2 against prod; enable prod timers; watch the next 05:05 run and its Slack post; then remove the
Hermes jobs. The final SQLite file is archived read-only (`orion-final-<stamp>.db`, chmod 400) on this host and as a copy in
Spaces, together with `signals.jsonl`. Fallback for the first week: re-enable the Hermes jobs on the archived copy; flow gaps
refill by backfill as after any outage.

### 8.5 Prod → staging refresh
The staging role cannot read prod, so prod exports and staging restores. Prod's nightly dump (§10) is written, group
`orion-refresh` (both users, mode 640), to `/srv/orion-refresh/latest.dump`. Staging's Sunday timer: `pg_restore --clean
--if-exists --no-owner --role=orion_stage` into `orion_stage`, then `TRUNCATE run_locks`, then `orion db status`. Staging's
own week of rows is overwritten, by design. The weekly restore doubles as the backup restore test, and its outcome posts to
#orion-staging. Orion holds no personal data, so no scrubbing step is needed.

## 9. Roles and the site's read-only access
Created by `scripts/provision/pg-roles.sql`, run once by Mike as `doadmin`:
- `REVOKE CONNECT ON DATABASE orion_prod, orion_stage FROM PUBLIC` (Postgres grants CONNECT and TEMP to PUBLIC by default;
  without this revoke the staging role could connect to prod).
- `orion_prod` owns database `orion_prod` and schema `orion`; `orion_stage` likewise for `orion_stage`; neither has any
  grant on the other's database (proved by a provisioning check: `orion_stage` connecting to `orion_prod` must fail).
- `coinrevs_site`: CONNECT on `orion_prod`, USAGE on schema `site` only, SELECT on its views; `default_transaction_read_only
  = on`, `statement_timeout = 5s`, connection limit 20, through DO's pool. Schema `site` is created empty now; Phase 5 fills
  it with the versioned export views. The site never reads `orion.*` tables directly, so Orion's schema can change without
  breaking the site.
- `orion_prod_ro`: SELECT on `orion.*`, used only by `orion-remote sql-ro` for Raymond's diagnostics (today's `sqlite3
  'file:...?mode=ro'` reads).
- One owner role per env does both migrations and runtime writes. A separate DML-only runtime role is possible but adds a
  credential per env for little gain at this size; not proposed.
Network: DO VPC between droplets and cluster; the cluster's trusted sources = the two droplets only. This host has no direct
route to prod; the import runs on the droplet with the backup file uploaded there.

## 10. Backups and PITR
- DO managed Postgres: daily full backups and write-ahead logs kept so the cluster can be restored to any point in the last
  **7 days** (DO docs, last verified by DO 2026-09-17), included in the price. A restore creates a new cluster, so
  `ORION_DATABASE_URL` changes in both `.env` files.
- Ours on top, because 7 days is short and backups go with a deleted cluster: `orion-dump.timer` (prod, 02:30 PT)
  `pg_dump -Fc` → `/srv/orion-refresh/latest.dump` and to DO Spaces (`orion-backups/prod/YYYY/MM/DD.dump`), keeping 30
  dailies and 12 monthlies (lifecycle rule). Today's DB is 28 MB; dumps will be a few MB compressed.
- Restore drill = the weekly staging refresh (§8.5) plus a documented PITR runbook in `docs/ops/`.

## 11. Costs (DO list prices read 2026-10-28; per month)

| item | size | price |
|---|---|---|
| Managed PostgreSQL, single node (no standby) | 1 GiB RAM, 1 vCPU, 10 GiB disk | $15.15 |
| Orion droplet (both users) | Basic 4 GiB / 2 vCPU / 80 GiB (the watcher's `small.en` ASR wants ~2 GB free; 2 GiB / 1 vCPU at $12 fits ticks only) | $24.00 |
| Spaces (dump storage) | 250 GiB included | $5 (not re-checked today) |
| Droplet backups | weekly, 20% of droplet | ~$5 (not re-checked today) |
| **Orion total** | | **~$49** |
| Website droplet | sized by the site, not this spec | from $6-$24 |

A standby node (automatic failover) adds roughly another node's price (estimate; DO's page prices it per added node and
it was not read today); not proposed at launch because ticks are a daily
batch and the site should serve a cached export if the cluster is briefly down (Phase 5). Data volume (measured): ~200
observation rows/day routine at 13 assets (backfill days reach 1-8.5k), plus ~11 fetch runs at ~3 kB each; that fits the
10 GiB disk for years even at 80-100 protocols, which the plan re-checks. Anthropic: option A
removes the 13 daily report-agent sessions; disclosure runs continue (prod only).

## 12. Decisions owed by Mike

| # | Question | Recommendation |
|---|---|---|
| D1 | Unix user names | `orion-prod`, `orion-stage`; DB roles `orion_prod`, `orion_stage` |
| D2 | How reports reach #orion-ops | **A**: Orion posts via a Slack webhook; `OnFailure` alert + a Hermes "ORION SILENT" watchdog; decisions go through Raymond over SSH |
| D3 | Staging output | Its own channel #orion-staging (failures and the weekly refresh only); needs a second webhook |
| D4 | Who provisions | Mike runs the DO console steps and the two provisioning scripts (root/doadmin stay with Mike); Raymond gets only the two forced-command keys |
| D5 | Prod soak rule | A tag must have completed one scheduled staging run before prod; `--no-soak` for hotfixes |
| D6 | Config proposals once assets live in the release | Approval becomes a commit + release: `proposals approve` on prod refuses `config` kind unless the running release's YAML hash already equals the proposal's, then records it approved |
| D7 | Timestamp type | `timestamptz`, read back as today's ISO strings (alternative: keep `text`, zero risk, worse for the site) |
| D8 | What history to carry | Kept tables in full; agent_runs rows all (spend history, 49 rows); transcripts of the disclosure run only (0.24 of 10.8 MB); `assumption_value` proposals not carried; everything else stays in the archived SQLite file |
| D9 | Test database | Real local Postgres per test file (not PGlite) |
| D10 | Dev Postgres on this host | Mike approves `apt install postgresql-<major>` (sudo) and a local role `orion_dev` |
| D11 | Disclosure watcher | Move it into the repo (`tools/disclosure-watcher/`), released and run by prod timers; staging runs it `--dry-run` |
| D12 | Postgres major | The newest major DO offers at provisioning, pinned on dev |
