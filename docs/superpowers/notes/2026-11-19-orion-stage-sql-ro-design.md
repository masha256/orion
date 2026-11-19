# Staging read-only SQL path (`orion_stage_ro`): design (RET-41 item 3)

Status: built on `chore/r2-followups` (scripts/provision only), not deployed. It reaches venus only when Mike re-runs
`orion-host.sh` from a provisioning snapshot that has it (scripts/provision/README.md section 4b).

## Problem

`orion-remote sql-ro` refused stage (`sql-ro is prod-only: staging has no read-only role`). R2's step 7 pre-check
(ruling R39: count rejected CoinGecko price rows before the rebuild) therefore needed `sudo -iu orion-stage` + `o db
query-ro` on stage. Raymond has no sudo on venus, so the stage check waited for Mike or was waived on indirect evidence
(prod's count, stage `data show` totals, anomalies; references/release-block-execution.md). Every later release block
with a read-only SQL pre-check hits the same wall.

## Design (chosen): a per-env read-only role, the twin of `orion_prod_ro`

- **Role** `orion_stage_ro`: `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`, no password (peer
  only), `default_transaction_read_only = on`, `statement_timeout = 30s`. Drift is put back on every run, as for the
  other three roles.
- **Isolation**: no membership in either direction among `orion_prod`, `orion_stage`, `orion_prod_ro`,
  `orion_stage_ro` (12 guarded pairs; `SET ROLE` across them is refused). `CONNECT` on `orion_stage` only (PUBLIC's
  CONNECT is already revoked on both databases, so it has none on `orion_prod`).
- **Grants** in `orion_stage`: `USAGE` on schema `orion`; `SELECT` on all its tables and views; `ALTER DEFAULT
  PRIVILEGES FOR ROLE orion_stage IN SCHEMA orion GRANT SELECT ON TABLES`, so tables and views created later stay
  readable: migrations, and `staging_refresh`, whose `pg_restore --clean --if-exists --no-owner --no-privileges
  --role=orion_stage` drops and re-creates every table of schema `orion` as `orion_stage` but never the schema itself
  (`planRestore` leaves the SCHEMA entry out), so the schema grant and the default ACL survive a weekly refresh. No
  grant on sequences or functions (nothing it needs; `SELECT` on a sequence is not required to read the tables).
- **Auth**: `pg_hba.conf` `local orion_stage orion_stage,orion_stage_ro peer map=stage`; `pg_ident.conf`
  `stage orion-stage orion_stage_ro`. Only the Unix user `orion-stage` can sign in as it; `orion-prod` cannot (no map
  line), and `orion-stage` still cannot reach `orion_prod` under any role.
- **orion-remote**: drop the prod-only refusal. `v_sql_ro` already passed `--role orion_<env>_ro` to `orion db query-ro`
  (node + pg, never psql: review C-1), so stage now signs in as `orion_stage_ro`; the one-argument, no-backslash,
  single-statement and 1 MB checks are unchanged. `orion db query-ro` adds its own `SET TRANSACTION READ ONLY` and the
  30 s `statement_timeout` (two layers: the role's privileges and the read-only transaction).

## Options rejected

- **Run stage's `query-ro` as `orion_stage` (the owner) inside a READ ONLY transaction.** No provisioning change, but
  the only barrier is the transaction mode, enforced by the client; the owner can `ALTER`, `DROP`, `TRUNCATE` and
  `GRANT` on every table. Prod chose privilege separation (spec §9.3); stage's data is a prod copy, so it gets the same.
- **Let stage use `orion_prod_ro`** (one shared read-only role): it would need CONNECT/SELECT on both databases and a
  map line from `orion-stage`, breaking the rule that nothing of one env's Unix user reaches the other env's database.
- **A new `sql-ro-stage` verb or a psql path**: psql runs backslash meta-commands from `-c`, `-f` and stdin (C-1); the
  existing verb already does the right thing once the role exists.

## Tests (no root, `scripts/provision/test/`)

- `run.sh` dry run of `orion-host.sh`: the new hba and ident lines, `ensure role orion_stage_ro`, its CONNECT and
  schema ensure lines, and the four new self-check lines.
- `sql-host.sh` (throwaway Postgres 18 cluster, `PG_BINDIR`): `host-roles.sql` twice (second run all `ok:`); the role's
  attributes and settings; no membership among the four roles; `orion_stage_ro` connects to `orion_stage` but not
  `orion_prod`; `SET ROLE orion_stage` refused; reads a table `orion_stage` creates later, and the same table after a
  drop + re-create plus a new view (what a `staging_refresh` restore does); refused: insert, insert in a `begin read
  write`, delete, create table; a revoked `SELECT` is put back on re-run (one `do:` line); with the real hba/ident
  from the dry run: `orion-stage` signs in as `orion_stage_ro` (read-only, cannot write, cannot reach `orion_prod`),
  `orion-prod` cannot sign in as it.
- `test_orion_remote.py`: stage `sql-ro` runs `orion db query-ro --role orion_stage_ro`, prod keeps `orion_prod_ro`
  (each env's own role, never the other), stage keeps every refusal with nothing run; every documented
  `ssh orion-prod|orion-stage "sql-ro ..."` line in docs/ops/deploy.md reaches `v_sql_ro` as one argument with its
  env's role (R2 step 7 now documents the stage form).

## Rollout and rollback

- One `orion-host.sh` re-run (README section 4b), no release, no daemon restart; Postgres reload only. Check after:
  the four new self-check PASS lines, then `ssh orion-stage "sql-ro \"select current_user\""` prints `orion_stage_ro`.
- An older provisioning snapshot re-run reinstalls the old orion-remote (stage `sql-ro` refused again) and rewrites
  hba/ident without the stage map lines, so `orion_stage_ro` can no longer sign in; the role itself stays (no script
  drops roles). To remove it fully: `REVOKE`/`DROP OWNED BY orion_stage_ro` in `orion_stage`, then `DROP ROLE`.

## Not changed

- `src/cli/commands/db.ts`'s `--role` help text still says "orion-remote passes orion_prod_ro"; it is release code and
  this branch changes no release artifact. Fix it in the next release branch ("orion_<env>_ro").
- deploy.md's stage pre-check forms keep the `sudo -iu orion-stage` fallback for the time before the re-run.
