import { loadBootstrapEnv, loadFixtureEnv, loadMigrationEnv } from "@contextvault/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, describe, expect, it } from "vitest";
import { deleteAccounts } from "./account-cleanup";
import { createDatabase } from "./client";
import { assertLeastPrivilege, PrivilegeCheckFailed } from "./privilege-check";
import { attempt, effectOf, openRolePools, ROLES, scalar } from "./role-test-support";
import { createTenantFixture, sqlState } from "./tenant-fixture";

// What each role can and cannot do, proven by running it (the catalog view is in role-model).
// Every probe statement runs in a transaction that is rolled back.
const pools = openRolePools();
const fx = await createTenantFixture(1);
afterAll(async () => {
  await fx.close();
  await pools.close();
});

const DENIED = "42501";
const bootstrapRole = await scalar<string>(pools.bootstrap, "select current_user as v");

describe("fixture role", () => {
  it("sees tenant rows that the application role cannot", async () => {
    const workspace = await fx.createWorkspace(await fx.seedUser());
    const count = (pool: typeof pools.fixture) =>
      scalar<number>(pool, "select count(*)::int as v from workspaces where id = $1", [workspace]);
    expect(await count(pools.fixture)).toBe(1);
    expect(await count(pools.app)).toBe(0);
    expect(await attempt(pools.fixture, "update users set email = email")).toBeUndefined();
  });

  it.each([
    ["create a table", "create table intruder (x int)"],
    ["create a temp table", "create temp table intruder (x int)"],
    ["create a schema", "create schema intruder"],
    ["create a function", "create function intruder() returns int language sql as 'select 1'"],
    ["alter a table", "alter table workspaces add column x int"],
    ["drop a table", "drop table memberships"],
    ["truncate", "truncate workspaces"],
    [
      "create a trigger",
      "create trigger t after insert on users for each row execute function workspaces_set_created_at()",
    ],
    ["disable RLS", "alter table workspaces disable row level security"],
    ["remove FORCE", "alter table workspaces no force row level security"],
    ["create a role", "create role intruder"],
    ["alter a role", "alter role contextvault_app bypassrls"],
    ["create an extension", "create extension hstore"],
    ["read the migration journal", "select * from drizzle.__drizzle_migrations"],
    ["read password hashes", "select rolpassword from pg_authid"],
    ["become the owner", "set role contextvault_owner"],
    ["become the application role", "set role contextvault_app"],
  ])("cannot %s", async (_name, statement) => {
    expect(await attempt(pools.fixture, statement)).toBe(DENIED);
  });
});

describe("fixture grants", () => {
  // GRANT without grant option only warns, so the proof is that no privilege changed.
  it.each([
    [
      "itself",
      ROLES.fixture,
      "select has_table_privilege('contextvault_fixture', 'users', 'TRUNCATE') as v",
    ],
    [
      "the application role",
      ROLES.app,
      "select has_table_privilege('contextvault_app', 'workspaces', 'DELETE') as v",
    ],
  ])("cannot hand out more to %s", async (_name, role, check) => {
    expect(await effectOf(pools.fixture, `grant all on users, workspaces to ${role}`, check)).toBe(
      false,
    );
  });
});

describe("owner role (migrations and provisioning)", () => {
  it("is bound by FORCE row level security on tenant tables", async () => {
    const workspace = await fx.createWorkspace(await fx.seedUser());
    const count = (pool: typeof pools.owner) =>
      scalar<number>(pool, "select count(*)::int as v from workspaces where id = $1", [workspace]);
    expect(await count(pools.fixture)).toBe(1);
    expect(await count(pools.owner)).toBe(0);
    expect(await attempt(pools.owner, "delete from workspaces")).toBeUndefined();
    expect(await count(pools.fixture)).toBe(1);
    expect(
      await attempt(
        pools.owner,
        "insert into workspaces (id, name, created_by) values (gen_random_uuid(), 'x', gen_random_uuid())",
      ),
    ).toBe(DENIED);
  });

  it("cannot turn row security off to read around the policies", async () => {
    expect(
      await attempt(pools.owner, "set local row_security = off; select * from workspaces"),
    ).toBe(DENIED);
  });

  it("can write the account tables it provisions and run DDL", async () => {
    expect(
      await attempt(
        pools.owner,
        "insert into users (id, email) values (gen_random_uuid(), 'owner-probe@test.invalid')",
      ),
    ).toBeUndefined();
    expect(
      await attempt(
        pools.owner,
        "create table owner_probe (x int); alter table owner_probe add column y int",
      ),
    ).toBeUndefined();
  });

  it.each([
    ["create a role", "create role intruder"],
    ["make the application role a superuser", "alter role contextvault_app superuser"],
    ["give the fixture role more", "alter role contextvault_fixture createrole"],
    ["become the bootstrap superuser", `set role ${bootstrapRole}`],
    ["become the fixture role", "set role contextvault_fixture"],
    ["drop the vector extension", "drop extension vector"],
    ["read password hashes", "select rolpassword from pg_authid"],
  ])("cannot %s", async (_name, statement) => {
    expect(await attempt(pools.owner, statement)).toBe(DENIED);
  });

  it("applies the committed migrations as a no-op and keeps the journal", async () => {
    const journal = () =>
      scalar<number>(pools.owner, "select count(*)::int as v from drizzle.__drizzle_migrations");
    const before = await journal();
    expect(before).toBeGreaterThanOrEqual(7);
    const folder = new URL("../../../infra/migrations", import.meta.url).pathname;
    await migrate(drizzle(pools.owner), { migrationsFolder: folder });
    expect(await journal()).toBe(before);
  });
});

describe("application role", () => {
  it.each([ROLES.owner, ROLES.fixture, bootstrapRole])("cannot assume %s", async (role) => {
    expect(await sqlState(fx.queryAs(null, `set role ${role}`))).toBe(DENIED);
  });

  it("cannot read password hashes", async () => {
    expect(await attempt(pools.app, "select rolpassword from pg_authid")).toBe(DENIED);
  });
});

describe("worker role", () => {
  it.each([ROLES.owner, ROLES.fixture, ROLES.app, bootstrapRole])(
    "cannot assume %s",
    async (role) => {
      expect(await attempt(pools.worker, `set role ${role}`)).toBe(DENIED);
    },
  );

  it.each([
    ["create a table", "create table intruder (x int)"],
    ["create a temp table", "create temp table intruder (x int)"],
    ["create a schema", "create schema intruder"],
    ["create a role", "create role intruder"],
    ["alter a role", "alter role contextvault_worker bypassrls"],
    ["alter a table", "alter table outbox add column x int"],
    ["disable RLS", "alter table outbox disable row level security"],
    ["truncate the outbox", "truncate outbox"],
    ["read the migration journal", "select * from drizzle.__drizzle_migrations"],
    ["read password hashes", "select rolpassword from pg_authid"],
  ])("cannot %s", async (_name, statement) => {
    expect(await attempt(pools.worker, statement)).toBe(DENIED);
  });
});

describe("assertLeastPrivilege refuses every role above the application role", () => {
  const check = async (connectionString: string) => {
    const handle = createDatabase({ connectionString, poolSize: 1 });
    try {
      await assertLeastPrivilege(handle.db);
    } finally {
      await handle.close();
    }
  };

  it.each([
    ["owner", () => loadMigrationEnv().DATABASE_MIGRATION_URL],
    ["fixture", () => loadFixtureEnv().DATABASE_FIXTURE_URL],
    ["bootstrap", () => loadBootstrapEnv().DATABASE_BOOTSTRAP_URL],
  ])("%s", async (_name, url) => {
    await expect(check(url())).rejects.toBeInstanceOf(PrivilegeCheckFailed);
  });
});

describe("account cleanup by a role that is bound by RLS", () => {
  // The guarantee: it cannot report success and it removes nothing. Which statement stops it (an
  // RLS-hidden count or the users foreign key) is not part of the guarantee.
  it("fails and leaves the account intact", async () => {
    const user = await fx.seedUser();
    const workspace = await fx.createWorkspace(user);
    await expect(deleteAccounts(pools.owner, [user])).rejects.toThrow();
    const left = (table: string, column: string, id: string) =>
      scalar<number>(
        pools.fixture,
        `select count(*)::int as v from ${table} where ${column} = $1`,
        [id],
      );
    expect(await left("users", "id", user)).toBe(1);
    expect(await left("workspaces", "id", workspace)).toBe(1);
    expect(await left("memberships", "user_id", user)).toBe(1);
  });
});
