#!/bin/sh
# Runs once, on first initialisation of the data volume, before 30-roles.sql (owner and fixture
# roles, ownership). POSTGRES_USER is the bootstrap superuser. contextvault_app is what the apps
# connect as: it must never own a table, bypass row-level security, or run DDL. Table grants and
# policies live in the migrations, not here. contextvault_worker is the ingestion worker's
# login: the same restrictions, no privileges until the migrations grant them. A volume that
# predates it gets it from `pnpm run infra:roles` (roles.sql).
set -eu

: "${POSTGRES_WORKER_PASSWORD:?set POSTGRES_WORKER_PASSWORD in .env before first start}"

psql -v ON_ERROR_STOP=1 -v app_password="$POSTGRES_APP_PASSWORD" \
  -v worker_password="$POSTGRES_WORKER_PASSWORD" -v db="$POSTGRES_DB" \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
CREATE ROLE contextvault_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  NOINHERIT PASSWORD :'app_password';
ALTER ROLE contextvault_app SET statement_timeout = '15s';
ALTER ROLE contextvault_app SET idle_in_transaction_session_timeout = '30s';
CREATE ROLE contextvault_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  NOINHERIT PASSWORD :'worker_password';
ALTER ROLE contextvault_worker SET statement_timeout = '15s';
ALTER ROLE contextvault_worker SET idle_in_transaction_session_timeout = '30s';

-- Default privileges on a database and on schema public are granted to PUBLIC; keep only CONNECT.
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db" TO contextvault_app, contextvault_worker;
GRANT USAGE ON SCHEMA public TO contextvault_app, contextvault_worker;
SQL
