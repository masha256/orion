#!/usr/bin/env bash
# dev-postgres.sh: PostgreSQL 18 from PGDG on the dev host (Ubuntu 24.04 noble), roles and databases for Orion dev.
# Spec §2.4 item 1, plan 1.5a Task 1. Mike runs it:  sudo scripts/provision/dev-postgres.sh
#
#   --dry-run          print every command and file it would write; changes nothing; needs no root
#   --force-os         run on another Ubuntu codename than noble
#   --os-user <user>   Unix user peer-mapped to role orion_dev (default: $SUDO_USER, i.e. who ran sudo)
#
# Idempotent: a second run prints only ok: lines (plus the self-check) and exits 0. Ends with PASS/FAIL lines.
set -euo pipefail
# shellcheck source-path=SCRIPTDIR

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=SCRIPTDIR/lib.sh
source "$here/lib.sh"

usage() { sed -n '2,9s/^# \{0,1\}//p' "${BASH_SOURCE[0]}"; }

OS_USER=${SUDO_USER:-}
while (($#)); do
  case $1 in
    --dry-run) DRY_RUN=1 ;;
    --force-os) FORCE_OS=1 ;;
    --os-user) [[ $# -ge 2 ]] || die "--os-user needs a value"; OS_USER=$2; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
  shift
done

((DRY_RUN)) && printf 'DRY RUN: nothing is changed; "would:" lines are what a real run does.\n'
require_codename noble
require_root
if [[ -z $OS_USER ]]; then
  if ((DRY_RUN)); then OS_USER=$(id -un); else die "pass --os-user <user> (no \$SUDO_USER to default to)"; fi
fi
[[ $OS_USER =~ ^[a-z_][a-z0-9_-]*$ ]] || die "--os-user '$OS_USER' is not a plain Unix user name"
getent passwd "$OS_USER" >/dev/null || die "Unix user '$OS_USER' does not exist"
[[ $OS_USER != root && $OS_USER != postgres ]] || die "--os-user must be your own user, not $OS_USER"

echo "== packages (PGDG)"
apt_pgdg
apt_install postgresql-$PG_MAJOR postgresql-client-$PG_MAJOR pgbackrest

echo "== cluster $PG_MAJOR/$PG_CLUSTER"
pg_ensure_cluster
pg_conf_dropin orion.conf <<'EOF'
# Orion dev settings (scripts/provision/dev-postgres.sh). Unix socket only; nothing on the network reaches it.
listen_addresses = ''
timezone = 'UTC'
shared_buffers = 256MB
EOF

backup_once "$PG_ETC/pg_hba.conf"
write_file "$PG_ETC/pg_hba.conf" 640 postgres:postgres <<'EOF'
# Written by scripts/provision/dev-postgres.sh (Orion). Local socket only; first match wins.
# TYPE  DATABASE  USER       METHOD
local   all       postgres   peer
local   all       orion_dev  peer map=dev
local   all       all        reject
EOF
((CHANGED)) && PG_RELOAD_NEEDED=1

backup_once "$PG_ETC/pg_ident.conf"
write_file "$PG_ETC/pg_ident.conf" 640 postgres:postgres <<EOF
# Written by scripts/provision/dev-postgres.sh (Orion).
# MAPNAME  SYSTEM-USERNAME  PG-USERNAME
dev        $OS_USER           orion_dev
EOF
((CHANGED)) && PG_RELOAD_NEEDED=1

pg_apply

echo "== roles and databases"
psql_file_as_postgres "$here/sql/dev-roles.sql"

echo "== self-check"
dev_psql() { (cd / && runuser -u "$OS_USER" -- psql -X -qAt -v ON_ERROR_STOP=1 -U orion_dev "$@"); }
dev_psql_as_postgres() { (cd / && runuser -u "$OS_USER" -- psql -X -qAt -U postgres -d postgres -c 'select 1'); }
check_version() { dev_psql -d orion_dev -c 'select version()' | grep -q "^PostgreSQL $PG_MAJOR\."; }
check_schema() {
  local s="selfcheck_$$"
  dev_psql -d orion_test -c "create schema $s" -c "drop schema $s"
}
check_pgdg() { dpkg-query -W -f='${Version}' "postgresql-$PG_MAJOR" | grep -q pgdg; }
check_socket_only() { [[ $(psql_as_postgres 'show listen_addresses') == '' ]]; }
check_utc() { [[ $(psql_as_postgres 'show timezone') == UTC ]]; }
selfcheck "postgresql-$PG_MAJOR is the PGDG build" check_pgdg
selfcheck "listen_addresses is empty (socket only)" check_socket_only
selfcheck "timezone is UTC" check_utc
selfcheck "select version() as $OS_USER -> orion_dev reports $PG_MAJOR.x" check_version
selfcheck "create + drop a schema in orion_test as $OS_USER" check_schema
selfcheck "$OS_USER cannot connect as postgres" expect_fail dev_psql_as_postgres
selfcheck_summary
