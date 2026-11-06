# Orion on Postgres: setup, migrations, the SQLite import and diagnostics

From Phase 1.5b (branch `feat/platform-pg`), Orion stores everything in PostgreSQL 18 and no longer uses `orion.db`.
The live install keeps running the SQLite release from `main` until the cutover (spec
`docs/superpowers/specs/2026-10-28-orion-platform-postgres-design.md` §8.4). **Do not merge this branch into `main`
before then.** Plan: `docs/superpowers/plans/2026-10-29-orion-phase1.5b-postgres.md`. Followups:
`docs/superpowers/notes/2026-10-29-orion-phase1.5b-postgres-followups.md`.

## Connection URLs always name the role

Postgres is reached over the local Unix socket with peer auth and no password. When the URL names no role, `pg` and
`psql` connect as the OS user (`hermes` on the dev host, `orion-prod` on venus). No role of that name exists, and
`pg_hba.conf` rejects it. So every URL names the role:

| where | variable | URL |
|---|---|---|
| dev host (uranus): the test suite | `ORION_TEST_DATABASE_URL` | `postgresql://orion_dev@/orion_test?host=/var/run/postgresql` |
| dev host: a dev or scratch home | `ORION_DATABASE_URL` | `postgresql://orion_dev@/orion_dev?host=/var/run/postgresql` |
| venus, prod (Unix user `orion-prod`) | `ORION_DATABASE_URL` | `postgresql://orion_prod@/orion_prod?host=/var/run/postgresql` |
| venus, staging (Unix user `orion-stage`) | `ORION_DATABASE_URL` | `postgresql://orion_stage@/orion_stage?host=/var/run/postgresql` |

A role-less URL such as `postgresql:///orion_test?host=/var/run/postgresql` fails with a peer-authentication or
`pg_hba.conf` rejection. Some older text gives that form, including the example in
`scripts/provision/files/env.template`, which is still to be fixed in provisioning.

## Environment

Orion reads these from the environment or `<ORION_HOME>/.env` (mode 600, git-ignored):

- `ORION_DATABASE_URL` (required). Without it, every command that opens the database fails with `no_database_url`.
  The URL is never printed. Errors name only the database and the schema (`db_connect_failed`: `cannot connect to
  database <db> (schema <schema>): ...`).
- `ORION_DB_SCHEMA` (optional, default `orion`). Must match `^[a-z_][a-z0-9_]{0,62}$`, else `invalid_db_schema`.
  Every connection runs with `search_path=<schema>` and `TimeZone=UTC`. Scratch and proof homes use their own schema
  (e.g. `proof_<stamp>`) in `orion_dev`. Advisory-lock keys include the schema, so two schemas never block each
  other.
- `ORION_TEST_DATABASE_URL` (tests only). It must point at a database whose name ends in `_test`. Without it the suite
  aborts in its global setup with a message, and it is never skipped. On any other database name, the setup refuses
  before it changes anything.

## Dev setup (the dev host, once)

The provisioning scripts are on `main` (`scripts/provision/`, Phase 1.5a). This branch was cut before they merged, so
run them from a checkout of `main`. Mike runs them as root. He has no `hermes` password, so he names the Unix user
explicitly:

```
sudo scripts/provision/dev-postgres.sh --dry-run --os-user hermes   # preview, changes nothing
sudo scripts/provision/dev-postgres.sh --os-user hermes
```

This installs PGDG PostgreSQL 18 (socket only, `timezone = 'UTC'`), creates role `orion_dev` (LOGIN, CREATEDB, no
password) and the databases `orion_dev` and `orion_test`, both owned by `orion_dev`, and peer-maps the Unix user
`hermes` to `orion_dev`. The run ends with `PASS:`/`FAIL:` self-check lines. A second run changes nothing.

Check it as `hermes`:

```
psql -X -U orion_dev -d orion_test -Atc 'select version()'     # PostgreSQL 18.x
```

Then the repository (from this worktree):

```
npm ci
npm run build          # tsc, plus copies src/db/pg/migrations/*.sql into dist/ (tsc does not emit .sql)
export ORION_TEST_DATABASE_URL='postgresql://orion_dev@/orion_test?host=/var/run/postgresql'
npx vitest run --maxWorkers=2
npm run typecheck
npm run lint:promises  # oxlint --type-aware no-floating-promises; also runs inside the suite
```

Tests create one fresh schema `t_<16 hex>` per test file in `orion_test`, with a pool of 1, and truncate every table
before each test. The global setup sets `synchronous_commit = off` on the test database (only on a `*_test` name).
This keeps the ingest tests from timing out on this host's slow fsync. It also drops `t_` schemas older than 6 hours
that a killed run left behind. To check that nothing is left after a run:

```
psql -X -U orion_dev -d orion_test -Atc "select nspname from pg_namespace where nspname like 't\_%'"
```

## Schema and migrations: `orion db status | migrate`

Migrations are `src/db/pg/migrations/NNNN_<name>.sql` (today only `0001_baseline`: the ten carried tables). They are
**never** applied on open. When a command opens the database and finds pending migrations, or no schema at all, it is
refused with `schema_behind` (`database schema <s> is at <n>, this build needs <m>: run orion db migrate`). A schema
ahead of the build is allowed.

```
orion db status [--json]          # current | behind (pending files listed) | ahead | changed (an applied file was edited)
orion db migrate [--json]         # creates the schema if absent, applies pending files, each in its own transaction
orion db migrate --breaking       # also applies a file whose first line is `-- breaking` (migrations are expand-only otherwise)
```

`db migrate` takes an advisory lock, so two migrators at once are safe: the second one skips what the first applied.
`orion init` creates only `assets/`, `personas/` and `skills/`; it does not touch the database. A new home is set
up with `.env` (URL + schema), then `orion db migrate`.

The Phase 2 release adds `0003_checks`, `0004_provenance` and `0005_tokens_prices`. Prod and stage must apply them in
the same release step (`staging_refresh` refuses a dump whose migrations differ), and the release needs three one-time
backfills after its switch (`db backfill-provenance`, the yCRV by-sender `data fetch`, `data backfill-tokens`): the
ordered commands and the rollback note are in `docs/ops/deploy.md`, "Phase 2 release (migrations 0003-0005)".

## Importing a SQLite `.backup` and proving the copy (`tools/import-sqlite`)

The tool is dev-only. It runs with `npx tsx` from the worktree and is not built into `dist/`. It reads a **copy** of
a SQLite database (never the live file), and it writes only to an empty, migrated schema. Run it as the controller,
never in a subagent: the snapshot holds production data, and the fetch leg needs a `.env` copy.

1. Snapshot, read-only:

   ```
   sqlite3 /home/hermes/git/orion/orion.db ".backup '<P>/snap.db'"
   sqlite3 <P>/snap.db 'PRAGMA integrity_check'      # ok
   chmod 600 <P>/snap.db
   ```

   The importer refuses a source whose `schema_migrations` max is not 8, or whose integrity check fails
   (`import_source_schema`).

2. Target home `<P>/new`: copies of `assets/`, `personas/`, `skills/`, and a `.env` (mode 600) holding only
   `ORION_DATABASE_URL=postgresql://orion_dev@/orion_dev?host=/var/run/postgresql` and `ORION_DB_SCHEMA=proof_<stamp>`
   (lowercase). Then `ORION_HOME=<P>/new node dist/cli/index.js db migrate --json`.

3. Import. It prints the manifest and writes `<manifest-dir>/import-<YYYYMMDDTHHMMSSZ>.json` (mode 600). Exit 0, or
   exit 1 with `{error:{code,message}}`:

   ```
   ORION_HOME=<P>/new npx tsx tools/import-sqlite/cli.ts import \
     --from <P>/snap.db --to 'postgresql://orion_dev@/orion_dev?host=/var/run/postgresql' \
     --schema proof_<stamp> --assets <worktree>/assets [--manifest-dir <dir>]   # default $ORION_HOME, else no_manifest_dir
   ```

   It runs as one transaction with `SET CONSTRAINTS ALL DEFERRED`. Every value is checked before anything is
   written, and the importer refuses rather than rewriting a value:
   - `import_bad_timestamp`: a timestamp that is not canonical 24-char ISO, or a `last_day` that is not `YYYY-MM-DD`.
   - `import_nul_byte`, `import_bad_value`.
   - `import_dangling_ref`: a carried row that points at an excluded one.
   - `import_target_not_current`, `import_target_not_empty`: the target is not migrated, or already holds rows.

   Identity sequences continue at `sqlite_sequence`.

   What is carried (D8, D3a): the ten tables in full, except:
   - observations of metrics that no asset YAML declares (`undeclared_metric`) or of unknown assets (`undeclared_asset`);
   - proposals of kind `assumption_value` (`retired_kind`);
   - transcripts of non-disclosure runs (`non_disclosure_transcript`; the runs themselves are kept and show the
     transcript as null).

   Not carried at all: `run_locks` (replaced by the advisory lock), `config_versions` (P1) and the eight valuation-era
   tables. The manifest lists every excluded id, so expect a long file.

4. Proof (exit 0 iff `ok`). Per table it compares the SQLite carried count, the Postgres rows and the manifest count,
   and a sha256 over per-row hashes (Postgres read through Orion's own `Db` parsers). It reports `first_mismatch` as
   `{pk, column, sqlite, pg}`. For each identity table it checks that the next id = `sqlite_sequence` + 1:

   ```
   npx tsx tools/import-sqlite/cli.ts proof --from <P>/snap.db --to '<same url>' --schema proof_<stamp> \
     --assets <worktree>/assets --manifest <dir>/import-<stamp>.json
   ```

5. Reports, old release vs new (exit 0 iff `ok`; 13 assets give 15 files: `report yield` per asset, `data anomalies`,
   `proposals list`). The old home is `assets/` (etc.) plus a fresh snapshot copy as `orion.db`. The new home is `<P>/new`.
   The old CLI is the SQLite release built in a detached `.worktrees/` checkout of `dcc2c48` (`npm ci && npm run build`).
   When the new CLI's `report yield --help` lists `--legacy` (Phase 2, D9), its reports run with `--legacy` and are
   compared without `incomeStatement` (the printed output is kept as `report-yield-<a>.unstripped.json`; the result
   says `"legacy": true`):

   ```
   npx tsx tools/import-sqlite/cli.ts reports \
     --old-cli <sqlite release>/dist/cli/index.js --old-home <P>/old \
     --new-cli <worktree>/dist/cli/index.js     --new-home <P>/new \
     --day <D> --manifest <dir>/import-<stamp>.json --out <dir>
   ```

   Each CLI runs as `node <cli> ...` with cwd = the home and `ORION_HOME` = the home. Every other `ORION_*` variable of
   the caller is dropped. A pair counts as identical only if stdout is non-empty and byte-equal. The old
   `proposals list` drops the manifest's excluded proposal ids. Output goes to `<out>/{old,new}/`, with stderr saved
   beside any file that wrote to it.

6. Ingest leg: `data fetch <a> --dry-run --json` with both releases at the same moment, for all 13 assets, in homes
   holding a live `.env` copy **with its `ORION_HOME=` line deleted** (the live `.env` points at production). Reduce
   each output to the sorted written metric keys plus `sourceId:status`, and refuse an empty result on either side.

7. Clean up: `drop schema proof_<stamp> cascade` in `orion_dev`, and delete the scratch homes, `.env` copies and the
   snapshot with `python3 -c "import shutil; shutil.rmtree('<dir>')"`.

`--to` is on the command line and so visible in `ps`. With peer auth and no password, that is harmless. `proof` does
not compare the manifest's `source.sha256` with `--from`. A different snapshot shows up as row mismatches.

## Diagnostic queries (Postgres versions of the old `sqlite3 orion.db` ones)

Open `psql` read-only on the right schema:

```
# dev / a scratch schema
PGOPTIONS='-c search_path=orion -c default_transaction_read_only=on' psql -X -U orion_dev -d orion_dev
# venus prod, as Unix user orion-prod: the read-only role (default_transaction_read_only = on, statement_timeout 30s)
PGOPTIONS='-c search_path=orion' psql -X -U orion_prod_ro -d orion_prod
```

The JSON columns are `json` (never `jsonb`), so use `->`, `->>` and `json_array_elements`. `json_extract(x,'$.k')`
becomes `x->>'k'`, and `json_each(x,'$.sources')` becomes `json_array_elements(x->'sources')`. Timestamps come back as
`timestamptz` in UTC.

Failed sources, newest first (was `json_each(f.detail_json,'$.sources')`):

```sql
select f.asset_id, f.started_at, s->>'sourceId' as source, left(s->>'error', 250) as error
from fetch_runs f, json_array_elements(f.detail_json->'sources') s
where s->>'status' <> 'ok' order by f.id desc limit 20;
```

The latest fetch per asset, with its failed-source count:

```sql
select distinct on (asset_id) asset_id, id, started_at, outcome,
  (select count(*) from json_array_elements(detail_json->'sources') s where s->>'status' <> 'ok') as failed_sources
from fetch_runs order by asset_id, id desc;
```

Open anomalies:

```sql
select id, asset_id, kind, metric_key, severity, occurrences, first_seen_at, last_seen_at
from anomalies where status = 'open' order by asset_id, id;
```

Values in force per metric:

```sql
select asset_id, metric_key, count(*) as rows, max(observed_at) as newest
from observations where superseded_by is null and status <> 'rejected'
group by asset_id, metric_key order by asset_id, metric_key;
```

Agent run budgets, with the weighted input units (uncached x1, cache write x1.25, cache read x0.1):

```sql
select id, asset_id, run_type, outcome, requests, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
  web_searches, web_fetches,
  input_tokens + 1.25 * cache_write_tokens + 0.1 * cache_read_tokens as input_units, error
from agent_runs where asset_id = 'lit' order by id;

select summary_json->'staged' as staged, summary_json->'reserve' as reserve from agent_runs where id = <id>;
```

What filled a transcript's context (message, block type, size, tool input):

```sql
select m.ord as message, b->>'type' as block_type, length(b::text) as chars, left((b->'input')::text, 120) as tool_input
from agent_transcripts t,
  json_array_elements(t.messages_json->'messages') with ordinality m(msg, ord),
  json_array_elements(case when json_typeof(m.msg->'content') = 'array' then m.msg->'content' else '[]'::json end) b
where t.run_id = <id> order by m.ord;
```

Rows dated in the future (the bad-run repair scan):

```sql
select 'observations' as t, count(*) from observations where observed_at > now() + interval '1 day'
union all select 'fetch_runs', count(*) from fetch_runs where started_at > now()
union all select 'agent_runs', count(*) from agent_runs where started_at > now();
```

Who holds a run lock. `run_locks` is gone: the run lock is a session advisory lock on its own connection, whose
`application_name` is the holder. `orion tick`/`agent run` report `run_in_progress` with the holder and since when.
A killed holder frees the lock at once.

```sql
select a.application_name as holder, a.backend_start as since, a.pid
from pg_locks l join pg_stat_activity a on a.pid = l.pid
where l.locktype = 'advisory' and l.granted and l.objsubid = 1
  and l.database = (select oid from pg_database where datname = current_database());
```

Schema state and sequences (`orion db status` gives the same verdict):

```sql
select id, name, applied_at from schema_migrations order by id;
select sequencename, last_value from pg_sequences where schemaname = current_schema() order by sequencename;
```

All of these were checked against a throwaway `0001_baseline` schema in `orion_test` (inside a rolled-back
transaction).

Two SQLite habits that no longer hold:
- `SUM`/`AVG` over an integer column returns `numeric`, which `pg` hands to Node as a string. Cast in code
  (`::float8`/`::bigint`); `tests/meta/aggregates.test.ts` enforces this.
- There is no `PRAGMA foreign_keys` off: FKs are enforced. `observations.superseded_by` is `DEFERRABLE INITIALLY
  IMMEDIATE`. A hand repair runs in one `begin ... commit`, with each statement pinned by id and asset.
