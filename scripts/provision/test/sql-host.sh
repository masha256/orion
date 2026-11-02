#!/usr/bin/env bash
# shellcheck shell=bash
# Sourced by test/sql.sh (PG_BINDIR set): host-roles.sql and the server's pg_hba.conf / pg_ident.conf against the
# throwaway cluster. The real Unix users orion-prod / orion-stage do not exist here, so each side is simulated by
# rewriting that one Unix name to the current user in a copy of the ident map printed by the orion-host.sh dry run.
# Uses ok/bad/tmp/prov and the sql_* helpers.
: "${tmp:?}" "${prov:?}"

sql_run_twice host-roles "$prov/sql/host-roles.sql"
sql_expect "roles are LOGIN only" "orion_prod|t|f|f|f
orion_prod_ro|t|f|f|f
orion_stage|t|f|f|f" postgres \
  "select rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole from pg_roles where rolname like 'orion\_%' and rolname <> 'orion_dev' order by 1"
sql_expect "databases owned by their env role" "orion_prod|orion_prod
orion_stage|orion_stage" postgres \
  "select datname, pg_get_userbyid(datdba) from pg_database where datname in ('orion_prod', 'orion_stage') order by 1"
sql_expect "schema orion in orion_prod owned by orion_prod" "orion_prod" orion_prod \
  "select pg_get_userbyid(nspowner) from pg_namespace where nspname = 'orion'"
sql_expect "schema orion in orion_stage owned by orion_stage" "orion_stage" orion_stage \
  "select pg_get_userbyid(nspowner) from pg_namespace where nspname = 'orion'"
sql_expect "orion_prod_ro settings" "default_transaction_read_only=on,statement_timeout=30s" postgres \
  "select array_to_string(array(select unnest(setconfig) order by 1), ',') from pg_db_role_setting where setrole = 'orion_prod_ro'::regrole and setdatabase = 0"
# CONNECT revoke, proven with trust auth (hba lets everything through, so only the database privilege can refuse)
sql_refused "CONNECT revoke: orion_stage cannot connect to orion_prod" orion_prod "select 1" orion_stage
sql_refused "CONNECT revoke: orion_prod cannot connect to orion_stage" orion_stage "select 1" orion_prod
sql_refused "CONNECT revoke: orion_prod_ro cannot connect to orion_stage" orion_stage "select 1" orion_prod_ro
sql_expect "orion_prod_ro can connect to orion_prod" "orion_prod_ro" orion_prod "select current_user" orion_prod_ro
sql_refused "SET ROLE orion_prod as orion_stage is refused" orion_stage "set role orion_prod" orion_stage
sql_refused "SET ROLE orion_prod as orion_prod_ro is refused" orion_prod "set role orion_prod" orion_prod_ro
# a table created by orion_prod later (as migrations will) is readable, not writable, by orion_prod_ro
sql_expect "orion_prod creates a table in schema orion" "" orion_prod \
  "create table orion.t (x int); insert into orion.t values (1)" orion_prod
sql_expect "orion_prod_ro reads it (default privileges)" "1" orion_prod "select count(*) from orion.t" orion_prod_ro
sql_refused "orion_prod_ro cannot insert" orion_prod "insert into orion.t values (2)" orion_prod_ro
sql_refused "orion_prod_ro cannot insert even in a read-write transaction" orion_prod \
  "begin read write; insert into orion.t values (2); commit" orion_prod_ro
sql_refused "orion_prod_ro cannot create a table" orion_prod "create table orion.u (x int)" orion_prod_ro
sql_expect "orion_stage cannot see orion_prod's tables (other database)" "0" orion_stage \
  "select count(*) from pg_tables where schemaname = 'orion'" orion_stage
# a grant drift is repaired on re-run
sql_q orion_prod "revoke usage on schema orion from orion_prod_ro" >/dev/null
"$PG_BINDIR/psql" -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres -f - <"$prov/sql/host-roles.sql" >"$tmp/host-roles-3.out" 2>&1
if grep -q '^do: grant usage on schema orion to orion_prod_ro' "$tmp/host-roles-3.out" &&
  [[ $(grep -vc '^ok: ' "$tmp/host-roles-3.out") -eq 1 ]]; then
  ok "host-roles: grant drift repaired (one do: line)"
else
  bad "host-roles: grant drift repaired" "$(grep -v '^ok: ' "$tmp/host-roles-3.out" | tr '\n' '|')"
fi

# --- the server's pg_hba.conf / pg_ident.conf, exactly as the orion-host.sh dry run prints them ------------------
me=$(id -un)
hba=$(sql_conf_from_dryrun host "$PG_ETC_T/pg_hba.conf" host.hba)
ident=$(sql_conf_from_dryrun host "$PG_ETC_T/pg_ident.conf" host.ident)
sed "s/^\(stage *\)orion-stage /\1$me /" "$ident" >"$tmp/host-as-stage.ident"
sed "s/^\(prod *\)orion-prod /\1$me /" "$ident" >"$tmp/host-as-prod.ident"

if sql_pg_restart_with "$hba" "$tmp/host-as-stage.ident"; then
  sql_expect "hba as orion-stage: connects to orion_stage as orion_stage" "orion_stage" orion_stage "select current_user" orion_stage
  sql_refused "hba as orion-stage: orion_prod as orion_stage refused" orion_prod "select 1" orion_stage
  sql_refused "hba as orion-stage: orion_prod as orion_prod refused (peer map)" orion_prod "select 1" orion_prod
  sql_refused "hba as orion-stage: orion_prod as orion_prod_ro refused (peer map)" orion_prod "select 1" orion_prod_ro
  sql_refused "hba as orion-stage: postgres refused" postgres "select 1" postgres
  sql_refused "hba as orion-stage: SET ROLE orion_prod refused" orion_stage "set role orion_prod" orion_stage
fi
if sql_pg_restart_with "$hba" "$tmp/host-as-prod.ident"; then
  sql_expect "hba as orion-prod: connects to orion_prod as orion_prod" "orion_prod" orion_prod "select current_user" orion_prod
  sql_expect "hba as orion-prod: connects to orion_prod as orion_prod_ro" "on" orion_prod \
    "show default_transaction_read_only" orion_prod_ro
  sql_refused "hba as orion-prod: orion_prod_ro cannot write" orion_prod "create table orion.v (x int)" orion_prod_ro
  sql_refused "hba as orion-prod: orion_stage refused" orion_stage "select 1" orion_prod
  sql_refused "hba as orion-prod: orion_stage as orion_stage refused (peer map)" orion_stage "select 1" orion_stage
fi
sql_pg_restart_with "" "" || true
