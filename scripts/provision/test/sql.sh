#!/usr/bin/env bash
# shellcheck shell=bash
# Sourced by test/run.sh when PG_BINDIR is set: runs the SQL files of scripts/provision/sql against a throwaway
# cluster (initdb in $tmp, socket only, trust auth, superuser "postgres"), twice each, as the current non-root user.
# Proves the guards: the first run creates, the second prints only "ok:" lines. Peer maps and Unix users cannot be
# tested this way (one Unix user, trust auth); the self-check of the real run covers them.
# Uses ok/bad/cleanup/tmp/prov/here from run.sh.
: "${tmp:?}" "${prov:?}" "${here:?}"

sql_pg_start() {
  local data=$tmp/pgdata sock=$tmp/pgsock
  mkdir -p "$sock"
  if ! "$PG_BINDIR/initdb" -D "$data" -U postgres -A trust --no-sync >"$tmp/initdb.out" 2>&1; then
    bad "initdb (PG_BINDIR=$PG_BINDIR)" "$(tail -n 3 "$tmp/initdb.out" | tr '\n' '|')"
    return 1
  fi
  if ! "$PG_BINDIR/pg_ctl" -D "$data" -l "$tmp/pg.log" -w \
    -o "-c listen_addresses='' -c unix_socket_directories='$sock' -c fsync=off" start >/dev/null 2>&1; then
    bad "pg_ctl start" "$(tail -n 3 "$tmp/pg.log" | tr '\n' '|')"
    return 1
  fi
  PGHOST=$sock
  export PGHOST
  trap 'sql_pg_stop; cleanup' EXIT
  ok "throwaway cluster ($("$PG_BINDIR/postgres" --version))"
}
sql_pg_stop() { "$PG_BINDIR/pg_ctl" -D "$tmp/pgdata" -m immediate stop >/dev/null 2>&1 || true; }

PG_ETC_T=${PG_ETC_FAKE:?} # the dry runs write their config there (test/run.sh)
# sql_conf_from_dryrun <case> <path> <out name>: the "    + " lines a dry run printed for <path>; prints the file name.
sql_conf_from_dryrun() {
  awk -v hdr="would: create $2 " '
    index($0, hdr) == 1 { on = 1; next }
    on && /^    \+ / { sub(/^    \+ /, ""); print; next }
    on && /^    \+$/ { print ""; next }
    on { exit }' "$tmp/$1.out" >"$tmp/$3"
  printf '%s' "$tmp/$3"
}
# sql_pg_restart_with <hba file or ""> <ident file or "">: restart the throwaway cluster with those files (empty: the
# initdb trust defaults). Fails (and reports) when the server rejects the files.
sql_pg_restart_with() {
  local opts="-c listen_addresses='' -c unix_socket_directories='$PGHOST' -c fsync=off"
  [[ -n $1 ]] && opts+=" -c hba_file='$1'"
  [[ -n $2 ]] && opts+=" -c ident_file='$2'"
  if [[ -n $1 && ! -s $1 ]] || [[ -n $2 && ! -s $2 ]]; then
    bad "hba/ident extracted from the dry run are empty"
    return 1
  fi
  "$PG_BINDIR/pg_ctl" -D "$tmp/pgdata" -m fast stop >/dev/null 2>&1
  if "$PG_BINDIR/pg_ctl" -D "$tmp/pgdata" -l "$tmp/pg.log" -w -o "$opts" start >/dev/null 2>&1; then
    [[ -n $1 ]] && ok "server accepts $(basename "$1") and $(basename "$2")"
    return 0
  fi
  bad "server start with $1 $2" "$(tail -n 3 "$tmp/pg.log" | tr '\n' '|')"
  return 1
}

# sql_q <db> <sql> [user]: one query, unaligned output
sql_q() { "$PG_BINDIR/psql" -X -qAt -U "${3:-postgres}" -d "$1" -c "$2"; }

# sql_run_twice <name> <file> [psql -v assignments...]
sql_run_twice() {
  local name=$1 file=$2 v args=()
  shift 2
  for v in "$@"; do args+=(-v "$v"); done
  if "$PG_BINDIR/psql" -X -q -v ON_ERROR_STOP=1 "${args[@]}" -U postgres -d postgres -f - <"$file" >"$tmp/$name-1.out" 2>&1; then
    ok "$name: first run exit 0"
  else
    bad "$name: first run exit non-zero" "$(tail -n 3 "$tmp/$name-1.out" | tr '\n' '|')"
  fi
  if grep -q '^do: ' "$tmp/$name-1.out"; then ok "$name: first run prints do: lines"; else bad "$name: first run prints do: lines"; fi
  if "$PG_BINDIR/psql" -X -q -v ON_ERROR_STOP=1 "${args[@]}" -U postgres -d postgres -f - <"$file" >"$tmp/$name-2.out" 2>&1; then
    ok "$name: second run exit 0"
  else
    bad "$name: second run exit non-zero" "$(tail -n 3 "$tmp/$name-2.out" | tr '\n' '|')"
  fi
  if grep -qv '^ok: ' "$tmp/$name-2.out"; then
    bad "$name: second run prints only ok: lines" "$(grep -v '^ok: ' "$tmp/$name-2.out" | head -n 3 | tr '\n' '|')"
  else
    ok "$name: second run prints only ok: lines ($(wc -l <"$tmp/$name-2.out"))"
  fi
}

# sql_expect <label> <expected> <db> <sql> [user]
sql_expect() {
  local got
  got=$(sql_q "$3" "$4" "${5:-postgres}" 2>&1)
  if [[ $got == "$2" ]]; then ok "sql: $1"; else bad "sql: $1" "got '$got', wanted '$2'"; fi
}
# sql_refused <label> <db> <sql> [user]
sql_refused() {
  if sql_q "$2" "$3" "${4:-postgres}" >/dev/null 2>&1; then bad "sql: $1 (was allowed)"; else ok "sql: $1"; fi
}

if sql_pg_start; then
  # --- dev-roles.sql ---
  sql_run_twice dev-roles "$prov/sql/dev-roles.sql"
  sql_expect "orion_dev is LOGIN CREATEDB, not superuser" "t|t|f" postgres \
    "select rolcanlogin, rolcreatedb, rolsuper from pg_roles where rolname = 'orion_dev'"
  sql_expect "orion_dev and orion_test owned by orion_dev" "orion_dev|orion_dev
orion_test|orion_dev" postgres \
    "select datname, pg_get_userbyid(datdba) from pg_database where datname like 'orion\_%' order by 1"
  sql_expect "orion_dev can create + drop a schema in orion_test" "" orion_test \
    "create schema selfcheck_x; drop schema selfcheck_x" orion_dev
  # drift is repaired: an owner change is put back
  sql_q postgres "alter database orion_test owner to postgres" >/dev/null
  "$PG_BINDIR/psql" -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres -f - <"$prov/sql/dev-roles.sql" >"$tmp/dev-roles-3.out" 2>&1
  if grep -q '^do: alter database orion_test owner to orion_dev' "$tmp/dev-roles-3.out"; then
    ok "dev-roles: owner drift repaired"
  else
    bad "dev-roles: owner drift repaired" "$(tr '\n' '|' <"$tmp/dev-roles-3.out")"
  fi

  # --- dev pg_hba.conf / pg_ident.conf exactly as the dev dry run prints them, with this Unix user as --os-user ---
  if sql_pg_restart_with "$(sql_conf_from_dryrun dev "$PG_ETC_T/pg_hba.conf" dev.hba)" \
    "$(sql_conf_from_dryrun dev "$PG_ETC_T/pg_ident.conf" dev.ident)"; then
    sql_expect "dev hba: $(id -un) connects to orion_test as orion_dev (peer map dev)" "orion_dev" orion_test \
      "select current_user" orion_dev
    sql_refused "dev hba: $(id -un) cannot connect as postgres" postgres "select 1" postgres
    sql_refused "dev hba: $(id -un) cannot connect as another role (reject)" orion_dev "select 1" nobody_role
    sql_pg_restart_with "" ""
  fi

  # shellcheck source=SCRIPTDIR/sql-host.sh
  source "$here/sql-host.sh"
fi
