import { afterAll, describe, expect, it } from "vitest";
import { createTenantFixture, sqlState } from "./tenant-fixture";

const fx = await createTenantFixture(1);
afterAll(() => fx.close());

describe("application role", () => {
  it("is not a superuser, does not bypass RLS, and owns nothing", async () => {
    const [role] = await fx.queryAs<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreaterole: boolean;
      rolcreatedb: boolean;
    }>(
      null,
      "select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb from pg_roles where rolname = current_user",
    );
    expect(role).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: false,
      rolcreatedb: false,
    });

    const owned = await fx.queryAs(
      null,
      `select 1 from pg_class c join pg_roles r on r.oid = c.relowner
       where r.rolname = current_user and c.relnamespace = 'public'::regnamespace`,
    );
    expect(owned).toHaveLength(0);
  });

  it("has RLS enabled everywhere and forced on tenant tables", async () => {
    const rows = await fx.queryAs<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      null,
      "select relname, relrowsecurity, relforcerowsecurity from pg_class where relname in ('users','workspaces','memberships') order by relname",
    );
    expect(rows).toEqual([
      { relname: "memberships", relrowsecurity: true, relforcerowsecurity: true },
      { relname: "users", relrowsecurity: true, relforcerowsecurity: false },
      { relname: "workspaces", relrowsecurity: true, relforcerowsecurity: true },
    ]);
  });

  it.each([
    ["create a table", "create table intruder (x int)"],
    ["create a temp table", "create temp table intruder (x int)"],
    ["create a schema", "create schema intruder"],
    ["alter a table", "alter table workspaces add column x int"],
    ["drop a table", "drop table memberships"],
    ["truncate", "truncate workspaces"],
    ["disable RLS", "alter table workspaces disable row level security"],
    ["create a role", "create role intruder"],
    ["update workspaces", "update workspaces set name = 'x'"],
    ["delete memberships", "delete from memberships"],
    ["insert users", "insert into users (id, email) values (gen_random_uuid(), 'x@test.invalid')"],
  ])("cannot %s", async (_name, statement) => {
    expect(await sqlState(fx.queryAs(null, statement))).toBe("42501");
  });

  it("cannot turn row security off to read around the policies", async () => {
    expect(
      await sqlState(fx.queryAs(null, "set local row_security = off; select * from workspaces")),
    ).toBe("42501");
  });
});
