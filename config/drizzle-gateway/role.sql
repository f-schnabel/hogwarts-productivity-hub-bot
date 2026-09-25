-- Scoped Postgres role for Drizzle Gateway.
-- Run as the postgres admin, NOT as a superuser connection for the app.
--
-- The role password is passed in as a psql variable so it never lands in
-- shell history or this file. Invoke like:
--
--   PW="$(openssl rand -base64 24)"
--   sudo -u postgres psql -d hogwarts_db -v gw_password="$PW" -f role.sql
--   echo "drizzle_admin password: $PW"   # hand to the operator, then clear scrollback
--
-- DB_NAME   = hogwarts_db
-- DB_SCHEMA = public
-- ALLOW_DDL = yes (CREATE ON SCHEMA granted below)

\set ON_ERROR_STOP on

-- Create the login role only if it does not already exist; always (re)set the
-- password so re-runs are idempotent.
SELECT format('CREATE ROLE drizzle_admin LOGIN PASSWORD %L', :'gw_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'drizzle_admin')
\gexec

ALTER ROLE drizzle_admin LOGIN PASSWORD :'gw_password';

-- Make sure it is NOT a superuser and cannot escalate.
ALTER ROLE drizzle_admin NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

GRANT CONNECT ON DATABASE hogwarts_db TO drizzle_admin;
GRANT USAGE ON SCHEMA public TO drizzle_admin;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO drizzle_admin;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO drizzle_admin;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO drizzle_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO drizzle_admin;

-- ALLOW_DDL = yes: let the role create/alter tables in this schema.
GRANT CREATE ON SCHEMA public TO drizzle_admin;

-- Sanity check (expects: rolsuper = f).
\echo 'drizzle_admin superuser flag (should be f):'
SELECT rolname, rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = 'drizzle_admin';
