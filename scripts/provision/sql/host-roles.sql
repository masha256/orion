-- host-roles.sql: Orion roles, databases and schemas on the server (spec §9.3, §2.4 item 3; plan 1.5a Task 2).
-- Run by orion-host.sh; also usable alone:  sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d postgres -f host-roles.sql
-- Every step is guarded: a re-run changes nothing and prints only "ok:" lines; drift (an owner, an attribute, a grant)
-- is put back and printed as "do:". Needs psql's \if (PostgreSQL >= 10); written for 18.
--
-- ensure: role orion_prod (LOGIN; no superuser/createdb/createrole/replication/bypassrls, no password: peer only)
-- ensure: role orion_stage (LOGIN; same attributes)
-- ensure: role orion_prod_ro (LOGIN; same attributes; default_transaction_read_only = on, statement_timeout = 30s)
-- ensure: no membership between orion_prod, orion_stage and orion_prod_ro (so SET ROLE across envs is refused)
-- ensure: database orion_prod owned by orion_prod
-- ensure: database orion_stage owned by orion_stage
-- ensure: REVOKE CONNECT, TEMPORARY ON DATABASE orion_prod, orion_stage FROM PUBLIC
-- ensure: GRANT CONNECT ON DATABASE orion_prod TO orion_prod_ro
-- ensure: schema orion in orion_prod owned by orion_prod
-- ensure: schema orion in orion_stage owned by orion_stage
-- ensure: orion_prod_ro: USAGE on schema orion, SELECT on all its tables, default SELECT on tables orion_prod creates

\set QUIET on

-- ---------------------------------------------------------------- roles
-- role orion_prod
SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'orion_prod') AS need \gset
\if :need
  \echo 'do: create role orion_prod LOGIN'
  CREATE ROLE orion_prod LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
\else
  SELECT NOT EXISTS (SELECT 1 FROM pg_authid WHERE rolname = 'orion_prod' AND rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls AND rolpassword IS NULL) AS need \gset
  \if :need
    \echo 'do: reset role orion_prod to LOGIN only (no superuser/createdb/createrole/replication/bypassrls/password)'
    ALTER ROLE orion_prod LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD NULL;
  \else
    \echo 'ok: role orion_prod'
  \endif
\endif

-- role orion_stage
SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'orion_stage') AS need \gset
\if :need
  \echo 'do: create role orion_stage LOGIN'
  CREATE ROLE orion_stage LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
\else
  SELECT NOT EXISTS (SELECT 1 FROM pg_authid WHERE rolname = 'orion_stage' AND rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls AND rolpassword IS NULL) AS need \gset
  \if :need
    \echo 'do: reset role orion_stage to LOGIN only (no superuser/createdb/createrole/replication/bypassrls/password)'
    ALTER ROLE orion_stage LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD NULL;
  \else
    \echo 'ok: role orion_stage'
  \endif
\endif

-- role orion_prod_ro
SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'orion_prod_ro') AS need \gset
\if :need
  \echo 'do: create role orion_prod_ro LOGIN'
  CREATE ROLE orion_prod_ro LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
\else
  SELECT NOT EXISTS (SELECT 1 FROM pg_authid WHERE rolname = 'orion_prod_ro' AND rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls AND rolpassword IS NULL) AS need \gset
  \if :need
    \echo 'do: reset role orion_prod_ro to LOGIN only (no superuser/createdb/createrole/replication/bypassrls/password)'
    ALTER ROLE orion_prod_ro LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD NULL;
  \else
    \echo 'ok: role orion_prod_ro'
  \endif
\endif

-- ---------------------------------------------------------------- read-only role settings (spec §9.3)
SELECT NOT EXISTS (
  SELECT 1 FROM pg_db_role_setting
  WHERE setdatabase = 0 AND setrole = 'orion_prod_ro'::regrole AND 'default_transaction_read_only=on' = ANY (setconfig)
) AS need \gset
\if :need
  \echo 'do: alter role orion_prod_ro set default_transaction_read_only=on'
  ALTER ROLE orion_prod_ro SET default_transaction_read_only = on;
\else
  \echo 'ok: orion_prod_ro default_transaction_read_only=on'
\endif

SELECT NOT EXISTS (
  SELECT 1 FROM pg_db_role_setting
  WHERE setdatabase = 0 AND setrole = 'orion_prod_ro'::regrole AND 'statement_timeout=30s' = ANY (setconfig)
) AS need \gset
\if :need
  \echo 'do: alter role orion_prod_ro set statement_timeout=30s'
  ALTER ROLE orion_prod_ro SET statement_timeout = '30s';
\else
  \echo 'ok: orion_prod_ro statement_timeout=30s'
\endif

-- ---------------------------------------------------------------- no cross-env membership (SET ROLE is refused)
SELECT EXISTS (
  SELECT 1 FROM pg_auth_members m
  WHERE m.roleid = 'orion_prod'::regrole AND m.member = 'orion_stage'::regrole
) AS need \gset
\if :need
  \echo 'do: revoke orion_prod from orion_stage'
  REVOKE orion_prod FROM orion_stage;
\else
  \echo 'ok: orion_stage is not a member of orion_prod'
\endif

SELECT EXISTS (
  SELECT 1 FROM pg_auth_members m
  WHERE m.roleid = 'orion_prod'::regrole AND m.member = 'orion_prod_ro'::regrole
) AS need \gset
\if :need
  \echo 'do: revoke orion_prod from orion_prod_ro'
  REVOKE orion_prod FROM orion_prod_ro;
\else
  \echo 'ok: orion_prod_ro is not a member of orion_prod'
\endif

SELECT EXISTS (
  SELECT 1 FROM pg_auth_members m
  WHERE m.roleid = 'orion_stage'::regrole AND m.member = 'orion_prod'::regrole
) AS need \gset
\if :need
  \echo 'do: revoke orion_stage from orion_prod'
  REVOKE orion_stage FROM orion_prod;
\else
  \echo 'ok: orion_prod is not a member of orion_stage'
\endif

SELECT EXISTS (
  SELECT 1 FROM pg_auth_members m
  WHERE m.roleid = 'orion_stage'::regrole AND m.member = 'orion_prod_ro'::regrole
) AS need \gset
\if :need
  \echo 'do: revoke orion_stage from orion_prod_ro'
  REVOKE orion_stage FROM orion_prod_ro;
\else
  \echo 'ok: orion_prod_ro is not a member of orion_stage'
\endif

SELECT EXISTS (
  SELECT 1 FROM pg_auth_members m
  WHERE m.roleid = 'orion_prod_ro'::regrole AND m.member = 'orion_prod'::regrole
) AS need \gset
\if :need
  \echo 'do: revoke orion_prod_ro from orion_prod'
  REVOKE orion_prod_ro FROM orion_prod;
\else
  \echo 'ok: orion_prod is not a member of orion_prod_ro'
\endif

SELECT EXISTS (
  SELECT 1 FROM pg_auth_members m
  WHERE m.roleid = 'orion_prod_ro'::regrole AND m.member = 'orion_stage'::regrole
) AS need \gset
\if :need
  \echo 'do: revoke orion_prod_ro from orion_stage'
  REVOKE orion_prod_ro FROM orion_stage;
\else
  \echo 'ok: orion_stage is not a member of orion_prod_ro'
\endif

-- ---------------------------------------------------------------- databases
-- database orion_prod
SELECT NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'orion_prod') AS need \gset
\if :need
  \echo 'do: create database orion_prod owner orion_prod'
  CREATE DATABASE orion_prod OWNER orion_prod;
\else
  SELECT NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'orion_prod' AND pg_get_userbyid(datdba) = 'orion_prod') AS need \gset
  \if :need
    \echo 'do: alter database orion_prod owner to orion_prod'
    ALTER DATABASE orion_prod OWNER TO orion_prod;
  \else
    \echo 'ok: database orion_prod owned by orion_prod'
  \endif
\endif

-- database orion_stage
SELECT NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'orion_stage') AS need \gset
\if :need
  \echo 'do: create database orion_stage owner orion_stage'
  CREATE DATABASE orion_stage OWNER orion_stage;
\else
  SELECT NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'orion_stage' AND pg_get_userbyid(datdba) = 'orion_stage') AS need \gset
  \if :need
    \echo 'do: alter database orion_stage owner to orion_stage'
    ALTER DATABASE orion_stage OWNER TO orion_stage;
  \else
    \echo 'ok: database orion_stage owned by orion_stage'
  \endif
\endif

-- PUBLIC gets CONNECT and TEMPORARY on every new database by default; without this revoke orion_stage could connect
-- to orion_prod (and the other way round).
SELECT EXISTS (
  SELECT 1 FROM pg_database d, aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a
  WHERE d.datname = 'orion_prod' AND a.grantee = 0 AND a.privilege_type IN ('CONNECT', 'TEMPORARY')
) AS need \gset
\if :need
  \echo 'do: revoke connect, temporary on database orion_prod from public'
  REVOKE CONNECT, TEMPORARY ON DATABASE orion_prod FROM PUBLIC;
\else
  \echo 'ok: public has no connect/temporary on database orion_prod'
\endif

-- PUBLIC gets CONNECT and TEMPORARY on every new database by default; without this revoke orion_stage could connect
-- to orion_prod (and the other way round).
SELECT EXISTS (
  SELECT 1 FROM pg_database d, aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a
  WHERE d.datname = 'orion_stage' AND a.grantee = 0 AND a.privilege_type IN ('CONNECT', 'TEMPORARY')
) AS need \gset
\if :need
  \echo 'do: revoke connect, temporary on database orion_stage from public'
  REVOKE CONNECT, TEMPORARY ON DATABASE orion_stage FROM PUBLIC;
\else
  \echo 'ok: public has no connect/temporary on database orion_stage'
\endif

-- orion_prod_ro may connect to orion_prod (and, with PUBLIC revoked, to nothing else of Orion's)
SELECT NOT EXISTS (
  SELECT 1 FROM pg_database d, aclexplode(d.datacl) a
  WHERE d.datname = 'orion_prod' AND a.grantee = 'orion_prod_ro'::regrole AND a.privilege_type = 'CONNECT'
) AS need \gset
\if :need
  \echo 'do: grant connect on database orion_prod to orion_prod_ro'
  GRANT CONNECT ON DATABASE orion_prod TO orion_prod_ro;
\else
  \echo 'ok: orion_prod_ro has connect on database orion_prod'
\endif

-- ---------------------------------------------------------------- schemas
-- schema orion in orion_prod
\connect orion_prod
\set QUIET on
SELECT NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'orion') AS need \gset
\if :need
  \echo 'do: create schema orion in orion_prod owned by orion_prod'
  CREATE SCHEMA orion AUTHORIZATION orion_prod;
\else
  SELECT NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'orion' AND pg_get_userbyid(nspowner) = 'orion_prod') AS need \gset
  \if :need
    \echo 'do: alter schema orion in orion_prod owner to orion_prod'
    ALTER SCHEMA orion OWNER TO orion_prod;
  \else
    \echo 'ok: schema orion in orion_prod owned by orion_prod'
  \endif
\endif

-- orion_prod_ro: read-only diagnostics (orion-remote sql-ro, Phase 1.5c)
SELECT NOT has_schema_privilege('orion_prod_ro', 'orion', 'USAGE') AS need \gset
\if :need
  \echo 'do: grant usage on schema orion to orion_prod_ro'
  GRANT USAGE ON SCHEMA orion TO orion_prod_ro;
\else
  \echo 'ok: orion_prod_ro has usage on schema orion'
\endif

SELECT count(*) > 0 AS need FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'orion' AND c.relkind IN ('r', 'v', 'm', 'p', 'f')
    AND NOT has_table_privilege('orion_prod_ro', c.oid, 'SELECT') \gset
\if :need
  \echo 'do: grant select on all tables in schema orion to orion_prod_ro'
  GRANT SELECT ON ALL TABLES IN SCHEMA orion TO orion_prod_ro;
\else
  \echo 'ok: orion_prod_ro has select on every table in schema orion'
\endif

SELECT NOT EXISTS (
  SELECT 1 FROM pg_default_acl d, aclexplode(d.defaclacl) a
  WHERE d.defaclrole = 'orion_prod'::regrole AND d.defaclnamespace = 'orion'::regnamespace AND d.defaclobjtype = 'r'
    AND a.grantee = 'orion_prod_ro'::regrole AND a.privilege_type = 'SELECT'
) AS need \gset
\if :need
  \echo 'do: alter default privileges for role orion_prod in schema orion grant select on tables to orion_prod_ro'
  ALTER DEFAULT PRIVILEGES FOR ROLE orion_prod IN SCHEMA orion GRANT SELECT ON TABLES TO orion_prod_ro;
\else
  \echo 'ok: default privileges: orion_prod_ro gets select on new orion_prod tables in schema orion'
\endif

-- schema orion in orion_stage
\connect orion_stage
\set QUIET on
SELECT NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'orion') AS need \gset
\if :need
  \echo 'do: create schema orion in orion_stage owned by orion_stage'
  CREATE SCHEMA orion AUTHORIZATION orion_stage;
\else
  SELECT NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'orion' AND pg_get_userbyid(nspowner) = 'orion_stage') AS need \gset
  \if :need
    \echo 'do: alter schema orion in orion_stage owner to orion_stage'
    ALTER SCHEMA orion OWNER TO orion_stage;
  \else
    \echo 'ok: schema orion in orion_stage owned by orion_stage'
  \endif
\endif

\connect postgres
