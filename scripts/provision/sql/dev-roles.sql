-- dev-roles.sql: Orion dev roles and databases on the dev host (spec §2.4 item 1, plan 1.5a Task 1).
-- Run by dev-postgres.sh; also usable alone:  sudo -u postgres psql -X -v ON_ERROR_STOP=1 -f dev-roles.sql
-- Every step is guarded: a re-run changes nothing and prints only "ok:" lines. Needs psql's \if (PostgreSQL >= 10).
--
-- ensure: role orion_dev (LOGIN, CREATEDB; no superuser, no createrole, no password: peer auth only)
-- ensure: database orion_dev owned by orion_dev
-- ensure: database orion_test owned by orion_dev

\set QUIET on

-- role orion_dev
SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'orion_dev') AS need \gset
\if :need
  \echo 'do: create role orion_dev LOGIN CREATEDB'
  CREATE ROLE orion_dev LOGIN CREATEDB NOSUPERUSER NOCREATEROLE NOREPLICATION NOBYPASSRLS;
\else
  SELECT NOT EXISTS (
    SELECT 1 FROM pg_authid WHERE rolname = 'orion_dev'
      AND rolcanlogin AND rolcreatedb AND NOT rolsuper AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls
      AND rolpassword IS NULL
  ) AS need \gset
  \if :need
    \echo 'do: reset role orion_dev to LOGIN CREATEDB (no superuser/createrole/replication/bypassrls/password)'
    ALTER ROLE orion_dev LOGIN CREATEDB NOSUPERUSER NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD NULL;
  \else
    \echo 'ok: role orion_dev'
  \endif
\endif

-- database orion_dev
SELECT NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'orion_dev') AS need \gset
\if :need
  \echo 'do: create database orion_dev owner orion_dev'
  CREATE DATABASE orion_dev OWNER orion_dev;
\else
  SELECT NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'orion_dev' AND pg_get_userbyid(datdba) = 'orion_dev') AS need \gset
  \if :need
    \echo 'do: alter database orion_dev owner to orion_dev'
    ALTER DATABASE orion_dev OWNER TO orion_dev;
  \else
    \echo 'ok: database orion_dev owned by orion_dev'
  \endif
\endif

-- database orion_test
SELECT NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'orion_test') AS need \gset
\if :need
  \echo 'do: create database orion_test owner orion_dev'
  CREATE DATABASE orion_test OWNER orion_dev;
\else
  SELECT NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'orion_test' AND pg_get_userbyid(datdba) = 'orion_dev') AS need \gset
  \if :need
    \echo 'do: alter database orion_test owner to orion_dev'
    ALTER DATABASE orion_test OWNER TO orion_dev;
  \else
    \echo 'ok: database orion_test owned by orion_dev'
  \endif
\endif
