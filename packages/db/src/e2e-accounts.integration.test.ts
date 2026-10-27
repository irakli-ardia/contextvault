import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { loadDatabaseEnv, loadFixtureEnv } from "@contextvault/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTenantFixture, type TenantFixture } from "./tenant-fixture";

// Runs the bundled CLI exactly as Playwright does, but with an explicit environment so only the
// variables a case names can reach it. Migration credentials are deliberately wrong or absent.
const bundle = "dist/e2e-accounts.mjs";
const badMigration = "postgres://nobody:wrong@127.0.0.1:1/none";

function cli(args: string[], env: Record<string, string>) {
  const { status, stdout, stderr } = spawnSync(process.execPath, [bundle, ...args], {
    cwd: new URL("..", import.meta.url).pathname,
    encoding: "utf8",
    env: { NODE_ENV: "development", ...env },
  });
  return { code: status, stdout, stderr };
}

let fx: TenantFixture;
const fixtureEnv = () => ({
  DATABASE_URL: loadDatabaseEnv().DATABASE_URL,
  DATABASE_MIGRATION_URL: badMigration,
  DATABASE_FIXTURE_URL: loadFixtureEnv().DATABASE_FIXTURE_URL,
});
const e2eEmail = () => `e2e-${randomUUID()}@test.invalid`;

beforeAll(async () => {
  execFileSync("pnpm", ["run", "bundle"], { cwd: new URL("..", import.meta.url).pathname });
  fx = await createTenantFixture(1);
}, 60_000);
afterAll(() => fx.close());

describe("e2e-accounts fixture routing", () => {
  it("reads and removes through DATABASE_FIXTURE_URL with unusable migration credentials", async () => {
    const email = e2eEmail();
    const id = randomUUID();
    await fx.fixture.query("insert into users (id, email) values ($1, $2)", [id, email]);

    const read = cli(["keys", email], fixtureEnv());
    expect(read).toMatchObject({ code: 0, stdout: "[]\n" });
    expect(cli(["remove", email], fixtureEnv()).code).toBe(0);
    expect((await fx.fixture.query("select 1 from users where id = $1", [id])).rowCount).toBe(0);
  });

  it("fails explicitly without DATABASE_FIXTURE_URL, even with a valid migration URL", () => {
    const { DATABASE_FIXTURE_URL: _omitted, ...rest } = fixtureEnv();
    const migration = { DATABASE_MIGRATION_URL: loadFixtureEnv().DATABASE_FIXTURE_URL };
    const result = cli(["keys", e2eEmail()], { ...rest, ...migration });
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("E2E_ACCOUNTS_FAILED\n");
  });

  it("does not fall back to migration credentials when the fixture credentials are wrong", () => {
    const url = new URL(loadFixtureEnv().DATABASE_FIXTURE_URL);
    const good = url.toString();
    url.password = "definitely-wrong";
    const result = cli(["keys", e2eEmail()], {
      ...fixtureEnv(),
      DATABASE_FIXTURE_URL: url.toString(),
      DATABASE_MIGRATION_URL: good,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("E2E_ACCOUNTS_FAILED\n");
    expect(result.stderr + result.stdout).not.toContain("definitely-wrong");
  });

  it("refuses to remove an account that does not exist, and removes nothing", async () => {
    const present = e2eEmail();
    const id = randomUUID();
    await fx.fixture.query("insert into users (id, email) values ($1, $2)", [id, present]);
    try {
      expect(cli(["remove", present, e2eEmail()], fixtureEnv()).code).toBe(1);
      expect((await fx.fixture.query("select 1 from users where id = $1", [id])).rowCount).toBe(1);
    } finally {
      expect(cli(["remove", present], fixtureEnv()).code).toBe(0);
    }
  });
});
