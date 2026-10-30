-- Role model for the development database (bootstrap superuser, contextvault_owner,
-- contextvault_fixture, contextvault_app, contextvault_worker). Run by the PostgreSQL entrypoint on a fresh volume and by
-- `pnpm run infra:roles` on an existing one; `-v rollback=1` (`infra:roles:rollback`) reverses it.
-- Must run as the bootstrap superuser. Passwords arrive in the environment (never on a command
-- line). Everything that could write a statement's text is switched off for this session: the
-- server's error, slow-statement and sampled logs, and psql's own error context (an error in an
-- ALTER ROLE would otherwise print it, with the password literal, to the terminal or container log).
-- The owner and fixture passwords are set on every run so the database follows .env: re-running
-- with a changed value rotates the password on purpose, and the new salt each time is not a change
-- in meaning. The worker role is the exception: it is created here only when missing (a volume that
-- predates it; a fresh volume gets it from init-roles.sh), with POSTGRES_WORKER_PASSWORD, and an
-- existing worker keeps its credential. Only its attributes, timeouts and CONNECT/USAGE converge.
--
-- Atomicity: everything is one explicit transaction and ON_ERROR_STOP is set, so a failure leaves
-- the catalog unchanged, whoever launched psql. Idempotent: a second run changes nothing but the
-- password salts. Ownership moves by explicit ALTER ... OWNER over the catalog; REASSIGN OWNED fails
-- on system objects, and extension members (the vector functions) are never touched.
\set QUIET on
\set VERBOSITY terse
\set ON_ERROR_STOP on
\set owner_password ''
\set fixture_password ''
\set worker_password ''
\getenv owner_password POSTGRES_OWNER_PASSWORD
\getenv fixture_password POSTGRES_FIXTURE_PASSWORD
\getenv worker_password POSTGRES_WORKER_PASSWORD

-- Session-level, before BEGIN: a sampled transaction is chosen when it starts, so the sampling
-- setting must already be off then. The session ends with this script.
set log_min_error_statement = 'panic';
set log_statement = 'none';
set log_min_duration_statement = -1;
set log_min_duration_sample = -1;
set log_transaction_sample_rate = 0;
begin;

do $$
begin
  if not (select rolsuper from pg_roles where rolname = current_user) then
    raise exception 'roles.sql must run as the bootstrap superuser';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'contextvault_app') then
    raise exception 'contextvault_app is missing (infra/postgres/init-roles.sh creates it)';
  end if;
end $$;

-- infra:roles passes the identity of the server it showed the operator; refuse any other server.
\if :{?expect_system_identifier}
  select (select system_identifier::text from pg_control_system()) = :'expect_system_identifier' as same_server \gset
  \if :same_server
  \else
    do $$ begin raise exception 'this is not the server that was confirmed'; end $$;
  \endif
\endif

\if :{?rollback}
  -- Nothing to reverse without both roles: refuse before changing anything.
  do $$
  begin
    if (select count(*) from pg_roles where rolname in ('contextvault_owner', 'contextvault_fixture')) <> 2 then
      raise exception 'rollback needs both contextvault_owner and contextvault_fixture';
    end if;
  end $$;
  -- Ownership goes back to the superuser that runs this script.
  select current_user as target \gset
\else
  select (:'owner_password' = '' or :'fixture_password' = '') as missing \gset
  \if :missing
    do $$ begin
      raise exception 'POSTGRES_OWNER_PASSWORD and POSTGRES_FIXTURE_PASSWORD must both be set';
    end $$;
  \endif
  select format('create role %I', r) from (values ('contextvault_owner'), ('contextvault_fixture')) v(r)
    where not exists (select 1 from pg_roles where rolname = r) \gexec
  alter role contextvault_owner with login nosuperuser nocreatedb nocreaterole noreplication
    nobypassrls noinherit password :'owner_password';
  alter role contextvault_fixture with login nosuperuser nocreatedb nocreaterole noreplication
    bypassrls noinherit password :'fixture_password';
  \set target contextvault_owner
  -- Created only when absent, so an existing credential is never reset.
  select not exists (select 1 from pg_roles where rolname = 'contextvault_worker') as create_worker \gset
  \if :create_worker
    select (:'worker_password' = '') as missing \gset
    \if :missing
      do $$ begin
        raise exception 'contextvault_worker is missing and POSTGRES_WORKER_PASSWORD is not set';
      end $$;
    \endif
    create role contextvault_worker login password :'worker_password';
  \endif
  alter role contextvault_worker with login nosuperuser nocreatedb nocreaterole noreplication
    nobypassrls noinherit;
  alter role contextvault_worker set statement_timeout = '15s';
  alter role contextvault_worker set idle_in_transaction_session_timeout = '30s';
  select format('grant connect on database %I to contextvault_worker', current_database()) \gexec
  grant usage on schema public to contextvault_worker;
\endif

select oid as target_oid from pg_roles where rolname = :'target' \gset

select format('alter database %I owner to %I', datname, :'target') from pg_database
  where datname = current_database() and datdba <> :target_oid \gexec
-- Schema public is owned by pg_database_owner and follows the database owner; leave that alone.
select format('alter schema %I owner to %I', nspname, :'target') from pg_namespace
  where nspname in ('public', 'drizzle') and nspowner <> :target_oid
    and nspowner <> 'pg_database_owner'::regrole \gexec
-- Serial/identity sequences follow their table; extension members belong to the extension.
select format('alter %s %I.%I owner to %I',
    case c.relkind when 'S' then 'sequence' when 'v' then 'view' when 'm' then 'materialized view'
      when 'f' then 'foreign table' else 'table' end, n.nspname, c.relname, :'target')
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('public', 'drizzle') and c.relowner <> :target_oid
    and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
    and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass
      and d.objid = c.oid and (d.deptype = 'e' or (c.relkind = 'S' and d.deptype in ('a', 'i')))) \gexec
select format('alter %s %I.%I(%s) owner to %I', case p.prokind when 'p' then 'procedure' else 'function' end,
    n.nspname, p.proname, pg_get_function_identity_arguments(p.oid), :'target')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'drizzle') and p.proowner <> :target_oid and p.prokind in ('f', 'p', 'w')
    and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass
      and d.objid = p.oid and d.deptype = 'e') \gexec

\if :{?rollback}
  -- DROP OWNED would drop whatever the owner still owns, so refuse unless it owns nothing here
  -- (default privileges are fine: removing them is the point).
  do $$
  begin
    if exists (select 1 from pg_shdepend s where s.refclassid = 'pg_authid'::regclass
        and s.deptype = 'o' and s.classid <> 'pg_default_acl'::regclass and s.refobjid in (select oid from pg_roles
          where rolname in ('contextvault_owner', 'contextvault_fixture'))
        and s.dbid in (0, (select oid from pg_database where datname = current_database()))) then
      raise exception 'a transition role still owns objects; ownership was not fully reversed';
    end if;
  end $$;
  drop owned by contextvault_fixture, contextvault_owner;
  drop role contextvault_fixture, contextvault_owner;
\else
  -- The fixture is DML-only: connect, read the public schema, nothing else. Anything wider (by hand
  -- or an earlier version of this file) is revoked first, and only when present, so a re-run
  -- converges without rewriting ACLs that are already right.
  select format('revoke all on database %I from contextvault_fixture', current_database())
    where has_database_privilege('contextvault_fixture', current_database(), 'CREATE,TEMPORARY') \gexec
  select format('grant connect on database %I to contextvault_fixture', current_database()) \gexec
  select format('revoke %s on schema %I from contextvault_fixture',
      case when nspname = 'public' then 'create' else 'all' end, nspname)
    from pg_namespace where nspname in ('public', 'drizzle')
      and has_schema_privilege('contextvault_fixture', oid,
        case when nspname = 'public' then 'CREATE' else 'USAGE,CREATE' end) \gexec
  grant usage on schema public to contextvault_fixture;
  select format('revoke all on %s %I.%I from contextvault_fixture',
      case when c.relkind = 'S' then 'sequence' else 'table' end, n.nspname, c.relname)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'drizzle') and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
      and case when c.relkind = 'S'
          then has_sequence_privilege('contextvault_fixture', c.oid, 'USAGE,SELECT,UPDATE')
          else has_table_privilege('contextvault_fixture', c.oid, 'TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
            or (n.nspname = 'drizzle'
              and has_table_privilege('contextvault_fixture', c.oid, 'SELECT,INSERT,UPDATE,DELETE'))
          end \gexec
  grant select, insert, update, delete on all tables in schema public to contextvault_fixture;
  -- Default privileges only shape functions created from now on, so a function that predates this
  -- script still has the PUBLIC EXECUTE it was created with. Remove it, so a transitioned database
  -- ends where a fresh one does. Only when present, to leave an already-correct ACL untouched.
  select format('revoke execute on routine %I.%I(%s) from public', n.nspname, p.proname,
      pg_get_function_identity_arguments(p.oid))
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'drizzle') and p.proowner = :target_oid and p.prokind in ('f', 'p', 'w')
      and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass
        and d.objid = p.oid and d.deptype = 'e')
      and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        where a.grantee = 0 and a.privilege_type = 'EXECUTE') \gexec
  -- Future owner-created objects (migrations): tables are reachable by the fixture, nothing else
  -- is, and new functions are not executable by PUBLIC (a migration grants EXECUTE explicitly).
  alter default privileges for role contextvault_owner in schema public
    grant select, insert, update, delete on tables to contextvault_fixture;
  alter default privileges for role contextvault_owner revoke execute on functions from public;

  do $$
  declare bad text;
  begin
    select string_agg(o, ', ') into bad from (
      select 'database' as o from pg_database
        where datname = current_database() and pg_get_userbyid(datdba) <> 'contextvault_owner'
      union all select 'schema ' || nspname from pg_namespace
        where nspname in ('public', 'drizzle')
          and pg_get_userbyid(nspowner) not in ('contextvault_owner', 'pg_database_owner')
      union all select 'relation ' || n.nspname || '.' || c.relname
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('public', 'drizzle') and pg_get_userbyid(c.relowner) <> 'contextvault_owner'
          and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
          and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
      union all select 'function ' || n.nspname || '.' || p.proname
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'drizzle') and pg_get_userbyid(p.proowner) <> 'contextvault_owner'
          and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
    ) x;
    if bad is not null then raise exception 'not owned by contextvault_owner: %', bad; end if;
    if exists (select 1 from pg_auth_members m join pg_roles r on r.oid in (m.roleid, m.member)
        where r.rolname in ('contextvault_owner', 'contextvault_fixture', 'contextvault_app',
          'contextvault_worker')) then
      raise exception 'unexpected role membership on a contextvault role';
    end if;
    if not exists (select 1 from pg_roles where rolname = 'contextvault_worker' and rolcanlogin
        and not (rolsuper or rolbypassrls or rolcreaterole or rolcreatedb or rolreplication)) then
      raise exception 'contextvault_worker is missing or has unexpected attributes';
    end if;
  end $$;
\endif
commit;
