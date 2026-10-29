import { afterAll, describe, expect, it } from "vitest";
import { openRolePools, ROLES, scalar } from "./role-test-support";

// The four-role model as the catalog reports it (infra/postgres/roles.sql): attributes, ownership,
// grants and default privileges. Behaviour (what each role can and cannot do) is in
// role-boundaries.integration.test.ts. Needs a database initialised or transitioned by roles.sql.
const pools = openRolePools();
afterAll(() => pools.close());

const APP_SCHEMAS = "('public', 'drizzle')";
const EXTENSION_MEMBER = (classid: string, oid: string) =>
  `exists (select 1 from pg_depend d where d.classid = '${classid}'::regclass and d.objid = ${oid} and d.deptype = 'e')`;

describe("each connection authenticates as its documented role", () => {
  it.each([
    ["DATABASE_MIGRATION_URL", "owner", ROLES.owner],
    ["DATABASE_FIXTURE_URL", "fixture", ROLES.fixture],
    ["DATABASE_URL", "app", ROLES.app],
  ] as const)("%s is %s", async (_variable, pool, role) => {
    expect(await scalar(pools[pool], "select current_user as v")).toBe(role);
  });

  it("DATABASE_BOOTSTRAP_URL is a superuser that is none of the three", async () => {
    const [name, superuser] = [
      await scalar<string>(pools.bootstrap, "select current_user as v"),
      await scalar<boolean>(
        pools.bootstrap,
        "select rolsuper as v from pg_roles where rolname = current_user",
      ),
    ];
    expect(superuser).toBe(true);
    expect(Object.values(ROLES)).not.toContain(name);
  });
});

describe("role attributes", () => {
  it("are exactly the intended ones", async () => {
    const { rows } = await pools.bootstrap.query(
      `select rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolcanlogin
       from pg_roles where rolname = any($1) order by rolname`,
      [Object.values(ROLES)],
    );
    const base = {
      rolsuper: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolreplication: false,
      rolcanlogin: true,
    };
    expect(rows).toEqual([
      { rolname: ROLES.app, rolbypassrls: false, ...base },
      { rolname: ROLES.fixture, rolbypassrls: true, ...base },
      { rolname: ROLES.owner, rolbypassrls: false, ...base },
    ]);
  });

  it("have no membership in or over any role, so none can SET ROLE to another", async () => {
    const { rows } = await pools.bootstrap.query(
      `select pg_get_userbyid(roleid) as granted, pg_get_userbyid(member) as member from pg_auth_members
       where pg_get_userbyid(roleid) = any($1) or pg_get_userbyid(member) = any($1)`,
      [Object.values(ROLES)],
    );
    expect(rows).toEqual([]);
  });
});

describe("ownership", () => {
  it("the owner owns the database, drizzle, every table and function; public follows the database", async () => {
    const database = await scalar(
      pools.bootstrap,
      "select pg_get_userbyid(datdba) as v from pg_database where datname = current_database()",
    );
    expect(database).toBe(ROLES.owner);
    const { rows: schemas } = await pools.bootstrap.query(
      `select nspname, pg_get_userbyid(nspowner) as owner from pg_namespace where nspname in ${APP_SCHEMAS} order by 1`,
    );
    expect(schemas).toEqual([
      { nspname: "drizzle", owner: ROLES.owner },
      { nspname: "public", owner: "pg_database_owner" },
    ]);
    const { rows: relations } = await pools.bootstrap.query<{ rel: string; owner: string }>(
      `select n.nspname || '.' || c.relname as rel, pg_get_userbyid(c.relowner) as owner
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname in ${APP_SCHEMAS} and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
         and not ${EXTENSION_MEMBER("pg_class", "c.oid")}`,
    );
    expect(relations.map((r) => r.rel)).toContain("drizzle.__drizzle_migrations");
    expect(relations.map((r) => r.rel)).toContain("public.workspaces");
    expect(relations.filter((r) => r.owner !== ROLES.owner)).toEqual([]);
    const { rows: functions } = await pools.bootstrap.query(
      `select p.proname, pg_get_userbyid(p.proowner) as owner from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ${APP_SCHEMAS} and not ${EXTENSION_MEMBER("pg_proc", "p.oid")}`,
    );
    expect(functions.length).toBeGreaterThan(0);
    expect(functions.filter((f) => f.owner !== ROLES.owner)).toEqual([]);
  });

  it("the fixture and app roles own nothing, here or in a shared object", async () => {
    const owned = await scalar<number>(
      pools.bootstrap,
      `select count(*)::int as v from pg_shdepend s join pg_roles r on r.oid = s.refobjid
       where s.refclassid = 'pg_authid'::regclass and s.deptype = 'o' and r.rolname = any($1)`,
      [[ROLES.fixture, ROLES.app]],
    );
    expect(owned).toBe(0);
  });

  it("the vector extension stays with the bootstrap superuser, out of the owner's reach", async () => {
    const owner = await scalar<string>(
      pools.bootstrap,
      "select pg_get_userbyid(extowner) as v from pg_extension where extname = 'vector'",
    );
    expect([ROLES.owner, ROLES.fixture, ROLES.app]).not.toContain(owner);
  });
});

describe("fixture privileges (effective, PUBLIC included)", () => {
  const has = (sql: string, ...values: unknown[]) =>
    scalar<boolean>(pools.bootstrap, `select ${sql} as v`, values);
  const fixture = `'${ROLES.fixture}'`;

  it("holds only SELECT, INSERT, UPDATE and DELETE, on every public table and nothing in drizzle", async () => {
    const { rows } = await pools.bootstrap.query<{ rel: string; granted: string }>(
      `select n.nspname || '.' || c.relname as rel,
         (select string_agg(p, ',' order by p) from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) p
          where has_table_privilege(${fixture}, c.oid, p)) as granted
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname in ${APP_SCHEMAS} and c.relkind in ('r', 'p') order by 1`,
    );
    expect(rows.length).toBeGreaterThan(7);
    for (const { rel, granted } of rows) {
      expect([rel, granted]).toEqual([
        rel,
        rel.startsWith("drizzle.") ? null : "DELETE,INSERT,SELECT,UPDATE",
      ]);
    }
  });

  it("can connect and read the public schema, and can create nothing anywhere", async () => {
    expect(await has(`has_database_privilege(${fixture}, current_database(), 'CONNECT')`)).toBe(
      true,
    );
    expect(
      await has(`has_database_privilege(${fixture}, current_database(), 'CREATE,TEMPORARY')`),
    ).toBe(false);
    expect(await has(`has_schema_privilege(${fixture}, 'public', 'USAGE')`)).toBe(true);
    expect(await has(`has_schema_privilege(${fixture}, 'public', 'CREATE')`)).toBe(false);
    expect(await has(`has_schema_privilege(${fixture}, 'drizzle', 'USAGE,CREATE')`)).toBe(false);
  });

  it("holds no sequence privilege", async () => {
    const granted = await scalar<number>(
      pools.bootstrap,
      `select count(*)::int as v from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname in ${APP_SCHEMAS} and c.relkind = 'S'
         and case when c.relkind = 'S' then has_sequence_privilege(${fixture}, c.oid, 'USAGE,SELECT,UPDATE') end`,
    );
    expect(granted).toBe(0);
  });
});

describe("default privileges for future owner-created objects", () => {
  it("are exactly: fixture DML on public tables, no PUBLIC EXECUTE on functions", async () => {
    const { rows } = await pools.bootstrap.query(
      `select pg_get_userbyid(d.defaclrole) as creator, d.defaclobjtype::text as kind,
         coalesce(d.defaclnamespace::regnamespace::text, '-') as schema,
         coalesce(nullif(pg_get_userbyid(a.grantee), ''), 'PUBLIC') as grantee, a.privilege_type as priv
       from pg_default_acl d, aclexplode(d.defaclacl) a order by 1, 2, 3, 4, 5`,
    );
    const creator = ROLES.owner;
    expect(rows).toEqual([
      { creator, kind: "f", schema: "-", grantee: creator, priv: "EXECUTE" },
      ...["DELETE", "INSERT", "SELECT", "UPDATE"].map((priv) => ({
        creator,
        kind: "r",
        schema: "public",
        grantee: ROLES.fixture,
        priv,
      })),
    ]);
  });

  it("leave no function in the app schemas executable by PUBLIC, whether created before or after the roles", async () => {
    const { rows } = await pools.bootstrap.query(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ${APP_SCHEMAS} and not ${EXTENSION_MEMBER("pg_proc", "p.oid")}
         and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
           where a.grantee = 0 and a.privilege_type = 'EXECUTE')`,
    );
    expect(rows).toEqual([]);
  });
});

describe("default privileges in effect", () => {
  it("apply to what the owner creates next: a table the fixture can use, a function nobody else can run", async () => {
    const client = await pools.owner.connect();
    try {
      await client.query("begin");
      await client.query("create table public.role_probe (id int)");
      await client.query(
        "create function public.role_probe_fn() returns int language sql as 'select 1'",
      );
      const { rows } = await client.query(
        `select has_table_privilege($1, 'public.role_probe', 'SELECT,INSERT,UPDATE,DELETE') as fixture_dml,
           has_table_privilege($1, 'public.role_probe', 'TRUNCATE') as fixture_truncate,
           has_table_privilege($2, 'public.role_probe', 'SELECT') as app_select,
           has_function_privilege($1, 'public.role_probe_fn()', 'EXECUTE') as fixture_exec,
           has_function_privilege($2, 'public.role_probe_fn()', 'EXECUTE') as app_exec,
           has_function_privilege(current_user, 'public.role_probe_fn()', 'EXECUTE') as owner_exec`,
        [ROLES.fixture, ROLES.app],
      );
      expect(rows[0]).toEqual({
        fixture_dml: true,
        fixture_truncate: false,
        app_select: false,
        fixture_exec: false,
        app_exec: false,
        owner_exec: true,
      });
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});
