# Orion Phase 1.5a: provisioning scripts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** idempotent bash scripts that Mike runs with sudo to (1) install Postgres 18 on this dev host and create the dev
and test databases, (2) set up the Ubuntu 26.04 stage/prod server: packages, Unix users, home layout, Postgres
databases and roles, pgBackRest scaffolding, firewall, keys, and a minimal SSH forced-command entry point.

**Architecture:** three scripts under `scripts/provision/` plus a shared `lib.sh`. Every state change goes through a
`run`/`write_file` helper that prints instead of acting under `--dry-run`, and that skips (printing `ok:`) when the
target state already holds. A self-check at the end prints PASS/FAIL lines Mike pastes back.

**Tech stack:** bash 5, `set -euo pipefail`, PGDG apt, `psql`, `ufw`, `openssl`, `ssh-keygen`, shellcheck.

**Spec:** `docs/superpowers/specs/2026-10-28-orion-platform-postgres-design.md` §2 (esp. §2.3-2.4), §3.4, §4, §9.2-9.3,
§10.1, §13.

Phase 1.5 is split into three plans, each a branch that stands alone: **1.5a provisioning (this)**, 1.5b Postgres
conversion + importer (`feat/platform-pg`), 1.5c daemon, publisher, Slack, release/deploy (`feat/daemon`). 1.5a does not
depend on Phase 1 or on the other two.

## Global constraints
- PostgreSQL **18** and **pgBackRest** from PGDG on both hosts (`noble-pgdg`, `resolute-pgdg`); never Ubuntu's archive
  packages for either.
- Dev host = Ubuntu 24.04 `noble`; server = Ubuntu 26.04 `resolute`. Each script refuses any other codename unless
  `--force-os`.
- Node on the server: official tarball **v26.13.0** linux-x64, sha256 pinned in the script from
  `https://nodejs.org/dist/v26.13.0/SHASUMS256.txt`, unpacked to `/opt/node-v26.13.0`, symlink `/opt/node-v26`.
  The dev host is not touched for Node.
- Unix users `orion-prod`, `orion-stage`; roles `orion_prod`, `orion_stage`, `orion_prod_ro`; databases `orion_prod`,
  `orion_stage`; schema `orion` in each, owned by the env role. Dev: role `orion_dev`, databases `orion_dev`,
  `orion_test`, peer-mapped from the invoking Unix user (`$SUDO_USER`, override `--os-user`).
- Postgres: Unix socket only (`listen_addresses = ''`), `timezone = 'UTC'`, settings in a drop-in
  `/etc/postgresql/18/main/conf.d/orion.conf`. `pg_hba.conf` / `pg_ident.conf` exactly as spec §9.3.
- No secret is ever printed, logged or written outside a mode-600 file. Generated private keys are never overwritten.
- Idempotent: a second run prints only `ok:` lines and exits 0. `--dry-run` changes nothing and needs no root.

## Rulings (binding; deviations from the spec text, with reasons)
- **R1 forced-command entry point** is `/usr/local/bin/orion-remote`, root-owned 755 (spec said `~/bin`): a release or
  the Orion user can then not replace what a leaked dev-host key runs. 1.5a installs a minimal version: reads
  `$SSH_ORIGINAL_COMMAND`, splits on whitespace without any shell evaluation, allows only `status` (env name from the
  Unix user, hostname, `~/current` target or `none`, `pg_isready` result) and refuses everything else with
  `orion-remote: '<verb>' not available yet (Phase 1.5c)` exit 64, logging each call to `~/remote.log`. 1.5c replaces
  it by re-running `orion-host.sh`.
- **R2 backups are a second step.** The first run writes `/etc/pgbackrest/pgbackrest.conf` from a template (root:postgres
  640) with `REPLACE_ME` placeholders for the Spaces endpoint, bucket, keys and cipher passphrase, and leaves
  `archive_mode` off. `orion-host.sh --enable-backups` refuses while any placeholder remains; otherwise runs
  `stanza-create`, sets `archive_mode = on` + `archive_command = 'pgbackrest --stanza=orion archive-push %p'` +
  `archive_timeout = 300`, restarts Postgres, runs `pgbackrest check`, and installs the root timers of spec §10.1
  (full Sun 09:00 UTC, diff daily 09:00 UTC; `pg_dump` 08:30 UTC with `age` to the recipient given by
  `--dump-recipient <age pubkey>`). Timers use `OnCalendar=... UTC`.
- **R3 firewall lockout guard.** `--ssh-from <ip|cidr>` is required (repeatable) to enable `ufw`; the script refuses to
  enable it if `$SSH_CLIENT`'s address is set and not covered by the list. Suggested values for Mike: this dev host
  `192.168.0.201` and its tailnet address `100.109.70.114`, plus his own machine.
- **R4 deferred to 1.5c** (the code they run does not exist yet): the `orion-daemon` user unit, the watcher venv and its
  packages, the full `orion-remote`. 1.5a creates the home layout they need.
- **R5 keys generated on the server per env user, never overwritten:** `~/shared/publish_ed25519` (ssh-keygen, no
  passphrase, comment `orion-<env>@<hostname> publish`) and `~/shared/snapshot-sign.key` (`openssl genpkey -algorithm
  ed25519`), both 600; the script prints only the public halves. Deploy keys from this host arrive as
  `--deploy-key-stage <pubkey file> --deploy-key-prod <pubkey file>` and are written as
  `restrict,command="/usr/local/bin/orion-remote" <key>` into each user's `~/.ssh/authorized_keys` (700/600); without
  the flags that step is skipped with a note.
- **R6 `.env` template:** `~/shared/.env` created once (600) with every key of spec §4 commented out and a one-line
  description each; never overwritten, never read by the script.
- **R7 memory:** `shared_buffers = 2GB` on the server, `256MB` on dev; nothing else tuned.
- **R8 testing without Docker:** `hermes` cannot use Docker (N13 open), so the gate is shellcheck clean + the dry-run
  test harness below. If Mike grants N13 later, a container test is added then.

## Review focus
1. A run over SSH that would enable `ufw` without covering the caller's address (R3) must refuse before any rule change.
2. A second run must not overwrite a filled `.env`, a generated key, or `pgbackrest.conf` once its placeholders are gone.
3. `orion-stage` must be unable to connect to `orion_prod` by any route (peer map, CONNECT revoke, `SET ROLE`); the
   self-check proves all three.
4. `orion-remote` must never pass caller text to a shell (`status; rm x`, `$(id)`, backticks, quotes).
5. `--dry-run` without root must not fail on the first root-only probe and must list every change a real run makes.

---

### Task 1: `lib.sh` + `dev-postgres.sh` + `pg-roles.sql` (dev part) + test harness
**Files:** create `scripts/provision/lib.sh`, `scripts/provision/dev-postgres.sh`, `scripts/provision/sql/dev-roles.sql`,
`scripts/provision/test/run.sh`, `scripts/provision/README.md`.
**Produces:** `lib.sh` functions `log_ok`, `log_do`, `die`, `run <cmd...>`, `write_file <path> <mode> <owner> <<content`
(writes only if content differs; dry-run prints a diff summary), `require_codename <name>`, `apt_pgdg` (adds the PGDG
keyring + `sources.list.d/pgdg.sources` for the running codename), `psql_as_postgres <sql>`, `selfcheck <name> <cmd>`.
- [ ] Test harness first: `test/run.sh` runs each script with `--dry-run --force-os` as non-root, asserts exit 0 and that
  the output names every planned change (PGDG source file, packages, conf.d file, hba/ident lines, each role/db), and runs
  `shellcheck -x` on every script. Fails now.
- [ ] Implement until the harness passes; `dev-postgres.sh` self-check = `select version()` reporting 18.x as the OS
  user, create + drop a schema in `orion_test`.
- [ ] Commit `feat(provision): dev-postgres.sh (PGDG Postgres 18, orion_dev/orion_test, peer map) + lib + dry-run harness`.

### Task 2: `orion-host.sh` + `sql/host-roles.sql` + `orion-remote` stub
**Files:** create `scripts/provision/orion-host.sh`, `scripts/provision/sql/host-roles.sql`,
`scripts/provision/files/orion-remote`, `scripts/provision/files/pgbackrest.conf.tmpl`,
`scripts/provision/files/env.template`; extend `test/run.sh`.
**Consumes:** `lib.sh` from Task 1.
- [ ] Harness cases first: dry-run lists Node tarball + sha check, users, linger, layout, `.env` template, keys, roles/dbs,
  hba/ident, pgbackrest template, ufw rules; `--ssh-from` missing → ufw step skipped with a note; a fake `SSH_CLIENT`
  outside the list → refusal (exit non-zero, before any ufw command); `--enable-backups` with placeholders → refusal;
  `orion-remote` unit tests with `SSH_ORIGINAL_COMMAND` set to `status`, `status; id`, `$(id)`, `` `id` ``, `install x`
  → only `status` succeeds, nothing is evaluated (use a PATH with a fake `pg_isready`).
- [ ] Implement; self-check lines: each env user connects to its own DB; `orion-stage` → `orion_prod` refused;
  `SET ROLE orion_prod` as `orion_stage` refused; `orion_prod_ro` cannot write; `pgbackrest check` (only with
  `--enable-backups`).
- [ ] Commit `feat(provision): orion-host.sh for the Ubuntu 26.04 server (users, layout, Postgres 18 roles, pgBackRest scaffold, ufw guard, keys, orion-remote stub)`.

### Task 3: runbook
- [ ] `scripts/provision/README.md`: exact order Mike runs (dev: `sudo scripts/provision/dev-postgres.sh`; server: copy
  the directory, `sudo ./orion-host.sh --hostname <h> --ssh-from <ip> ...`, fill `/etc/pgbackrest/pgbackrest.conf`, then
  `--enable-backups --dump-recipient <age pubkey>`), what each prints, what to paste back.
- [ ] Commit `docs(provision): runbook`.
