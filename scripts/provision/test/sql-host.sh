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
orion_stage|t|f|f|f
orion_stage_ro|t|f|f|f" postgres \
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
sql_expect "orion_stage_ro settings" "default_transaction_read_only=on,statement_timeout=30s" postgres \
  "select array_to_string(array(select unnest(setconfig) order by 1), ',') from pg_db_role_setting where setrole = 'orion_stage_ro'::regrole and setdatabase = 0"
sql_expect "no membership among the four Orion roles" "0" postgres \
  "select count(*) from pg_auth_members where roleid::regrole::text in ('orion_prod', 'orion_stage', 'orion_prod_ro', 'orion_stage_ro') or member::regrole::text in ('orion_prod', 'orion_stage', 'orion_prod_ro', 'orion_stage_ro')"
# CONNECT revoke, proven with trust auth (hba lets everything through, so only the database privilege can refuse)
sql_refused "CONNECT revoke: orion_stage cannot connect to orion_prod" orion_prod "select 1" orion_stage
sql_refused "CONNECT revoke: orion_prod cannot connect to orion_stage" orion_stage "select 1" orion_prod
sql_refused "CONNECT revoke: orion_prod_ro cannot connect to orion_stage" orion_stage "select 1" orion_prod_ro
sql_expect "orion_prod_ro can connect to orion_prod" "orion_prod_ro" orion_prod "select current_user" orion_prod_ro
sql_refused "CONNECT revoke: orion_stage_ro cannot connect to orion_prod" orion_prod "select 1" orion_stage_ro
sql_expect "orion_stage_ro can connect to orion_stage" "orion_stage_ro" orion_stage "select current_user" orion_stage_ro
sql_refused "SET ROLE orion_prod as orion_stage is refused" orion_stage "set role orion_prod" orion_stage
sql_refused "SET ROLE orion_stage as orion_stage_ro is refused" orion_stage "set role orion_stage" orion_stage_ro
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
# the same for orion_stage_ro on orion_stage: a table orion_stage creates later (migrations, and staging_refresh's
# pg_restore --clean --role=orion_stage, which drops and re-creates every table of schema orion) is readable only
sql_expect "orion_stage creates a table in schema orion" "" orion_stage \
  "create table orion.t (x int); insert into orion.t values (1)" orion_stage
sql_expect "orion_stage_ro reads it (default privileges)" "1" orion_stage "select count(*) from orion.t" orion_stage_ro
sql_expect "orion_stage drops and re-creates it (as a staging_refresh restore does)" "" orion_stage \
  "drop table orion.t; create table orion.t (x int); insert into orion.t values (1), (2); create view orion.tv as select x from orion.t" orion_stage
sql_expect "orion_stage_ro reads the re-created table and a new view" "2|2" orion_stage \
  "select (select count(*) from orion.t), (select count(*) from orion.tv)" orion_stage_ro
sql_refused "orion_stage_ro cannot insert" orion_stage "insert into orion.t values (3)" orion_stage_ro
sql_refused "orion_stage_ro cannot insert even in a read-write transaction" orion_stage \
  "begin read write; insert into orion.t values (3); commit" orion_stage_ro
sql_refused "orion_stage_ro cannot create a table" orion_stage "create table orion.u (x int)" orion_stage_ro
sql_refused "orion_stage_ro cannot delete" orion_stage "begin read write; delete from orion.t; commit" orion_stage_ro
sql_expect "orion_stage_ro gets nothing from orion_prod (no select, no connect)" "f|f" postgres \
  "select has_database_privilege('orion_stage_ro', 'orion_prod', 'CONNECT'), has_database_privilege('orion_prod_ro', 'orion_stage', 'CONNECT')"
# a grant drift is repaired on re-run
sql_q orion_prod "revoke usage on schema orion from orion_prod_ro" >/dev/null
"$PG_BINDIR/psql" -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres -f - <"$prov/sql/host-roles.sql" >"$tmp/host-roles-3.out" 2>&1
if grep -q '^do: grant usage on schema orion to orion_prod_ro' "$tmp/host-roles-3.out" &&
  [[ $(grep -vc '^ok: ' "$tmp/host-roles-3.out") -eq 1 ]]; then
  ok "host-roles: grant drift repaired (one do: line)"
else
  bad "host-roles: grant drift repaired" "$(grep -v '^ok: ' "$tmp/host-roles-3.out" | tr '\n' '|')"
fi

sql_q orion_stage "revoke select on orion.t from orion_stage_ro" >/dev/null
"$PG_BINDIR/psql" -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres -f - <"$prov/sql/host-roles.sql" >"$tmp/host-roles-4.out" 2>&1
if grep -q '^do: grant select on all tables in schema orion to orion_stage_ro' "$tmp/host-roles-4.out" &&
  [[ $(grep -vc '^ok: ' "$tmp/host-roles-4.out") -eq 1 ]]; then
  ok "host-roles: orion_stage_ro grant drift repaired (one do: line)"
else
  bad "host-roles: orion_stage_ro grant drift repaired" "$(grep -v '^ok: ' "$tmp/host-roles-4.out" | tr '\n' '|')"
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
  sql_expect "hba as orion-stage: connects to orion_stage as orion_stage_ro (read-only)" "on" orion_stage \
    "show default_transaction_read_only" orion_stage_ro
  sql_refused "hba as orion-stage: orion_stage_ro cannot write" orion_stage "create table orion.w (x int)" orion_stage_ro
  sql_refused "hba as orion-stage: orion_prod as orion_stage_ro refused" orion_prod "select 1" orion_stage_ro
fi
if sql_pg_restart_with "$hba" "$tmp/host-as-prod.ident"; then
  sql_expect "hba as orion-prod: connects to orion_prod as orion_prod" "orion_prod" orion_prod "select current_user" orion_prod
  sql_expect "hba as orion-prod: connects to orion_prod as orion_prod_ro" "on" orion_prod \
    "show default_transaction_read_only" orion_prod_ro
  sql_refused "hba as orion-prod: orion_prod_ro cannot write" orion_prod "create table orion.v (x int)" orion_prod_ro
  sql_refused "hba as orion-prod: orion_stage refused" orion_stage "select 1" orion_prod
  sql_refused "hba as orion-prod: orion_stage as orion_stage refused (peer map)" orion_stage "select 1" orion_stage
  sql_refused "hba as orion-prod: orion_stage as orion_stage_ro refused (peer map)" orion_stage "select 1" orion_stage_ro
fi
sql_pg_restart_with "" "" || true
