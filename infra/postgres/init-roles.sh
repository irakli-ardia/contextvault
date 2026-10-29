#!/bin/sh
# Runs once, on first initialisation of the data volume, before 30-roles.sql (owner and fixture
# roles, ownership). POSTGRES_USER is the bootstrap superuser. contextvault_app is what the apps
# connect as: it must never own a table, bypass row-level security, or run DDL. Table grants and
# policies live in the migrations, not here.
set -eu

psql -v ON_ERROR_STOP=1 -v app_password="$POSTGRES_APP_PASSWORD" -v db="$POSTGRES_DB" \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
CREATE ROLE contextvault_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  NOINHERIT PASSWORD :'app_password';
ALTER ROLE contextvault_app SET statement_timeout = '15s';
ALTER ROLE contextvault_app SET idle_in_transaction_session_timeout = '30s';

-- Default privileges on a database and on schema public are granted to PUBLIC; keep only CONNECT.
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db" TO contextvault_app;
GRANT USAGE ON SCHEMA public TO contextvault_app;
SQL
