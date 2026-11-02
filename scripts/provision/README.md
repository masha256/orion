# scripts/provision

Provisioning scripts for Orion's Postgres hosts (spec §2.4, plan 1.5a). Mike runs them with sudo; Raymond writes and
dry-runs them.

| file | what |
|---|---|
| `dev-postgres.sh` | dev host (Ubuntu 24.04 noble): PGDG PostgreSQL 18 + pgBackRest, role `orion_dev`, databases `orion_dev` and `orion_test`, peer map from your Unix user |
| `lib.sh` | shared helpers (`run`, `write_file`, `selfcheck`, ...): every change prints `do:`/`would:`, every state that already holds prints `ok:` |
| `sql/dev-roles.sql` | the dev roles/databases, guarded (re-run = no-op); usable alone with `sudo -u postgres psql -f` |
| `test/run.sh` | dry-run harness: shellcheck + every script with `--dry-run` as non-root |

Dry run (no root, changes nothing): `scripts/provision/dev-postgres.sh --dry-run`.

Tests: `SHELLCHECK=/path/to/shellcheck scripts/provision/test/run.sh`; add `PG_BINDIR=/usr/lib/postgresql/18/bin` to
also run the SQL files twice against a throwaway cluster.
