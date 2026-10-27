import { loadDatabaseEnv, loadFixtureEnv } from "@contextvault/config";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTenantFixture } from "./tenant-fixture";

const fixtureUrl = () => loadFixtureEnv().DATABASE_FIXTURE_URL;
const fixtureUser = () => decodeURIComponent(new URL(fixtureUrl()).username);

afterEach(() => vi.unstubAllEnvs());

describe("fixture connection", () => {
  it("seeds and cleans up as the DATABASE_FIXTURE_URL role", async () => {
    const fx = await createTenantFixture(1);
    const { rows } = await fx.fixture.query<{ u: string }>("select current_user as u");
    expect(rows[0]?.u).toBe(fixtureUser());
    const id = await fx.seedUser();
    expect((await fx.fixture.query("select 1 from users where id = $1", [id])).rowCount).toBe(1);
    await fx.close();
    const check = new pg.Pool({ connectionString: fixtureUrl() });
    try {
      expect((await check.query("select 1 from users where id = $1", [id])).rowCount).toBe(0);
    } finally {
      await check.end();
    }
  });

  it("refuses to start without DATABASE_FIXTURE_URL, whatever other URLs are set", async () => {
    vi.stubEnv("DATABASE_FIXTURE_URL", undefined);
    expect(loadDatabaseEnv().DATABASE_URL).toBeDefined();
    await expect(createTenantFixture()).rejects.toThrow(/DATABASE_FIXTURE_URL/);
  });

  it("does not fall back when the fixture credentials are invalid", async () => {
    const url = new URL(fixtureUrl());
    url.password = "definitely-wrong";
    vi.stubEnv("DATABASE_FIXTURE_URL", url.toString());
    const error = await createTenantFixture(1).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("definitely-wrong");
  });

  // The factory never returns a pool that failed the role check, so no test can query it directly.
  it("refuses the application role before returning a fixture, and closes its pool", async () => {
    const probe = new pg.Pool({ connectionString: fixtureUrl(), max: 1 });
    try {
      const app = new URL(loadDatabaseEnv().DATABASE_URL);
      const open = async () =>
        Number(
          (
            await probe.query<{ n: string }>(
              "select count(*) as n from pg_stat_activity where usename = $1",
              [decodeURIComponent(app.username)],
            )
          ).rows[0]?.n,
        );
      const before = await open();
      vi.stubEnv("DATABASE_FIXTURE_URL", app.toString());
      const error = await createTenantFixture(1).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(String(error)).toContain("FIXTURE_ROLE_CANNOT_SEE_ALL");
      expect(String(error)).not.toContain(app.password);
      await vi.waitFor(async () => expect(await open()).toBe(before));
    } finally {
      await probe.end();
    }
  });
});
