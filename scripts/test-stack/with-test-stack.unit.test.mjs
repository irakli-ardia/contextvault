import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEV, db, okProbes, TEST, useStack } from "./with-test-stack.fixtures.mjs";
import { buildChildEnv, loadTestEnv } from "./with-test-stack.mjs";

const { state, setup, start, parentEnv, stderr, write } = useStack();
const calls = () => state.calls;
const repo = () => state.repo;
const ext = () => state.ext;

describe("configuration", () => {
  it("passes a complete loopback test configuration and runs the child once", async () => {
    expect(await start(parentEnv())).toBe(0);
    expect(calls()).toHaveBeenCalledOnce();
  });

  it("requires CV_TEST_ENV_DIR with no default", async () => {
    expect(await start({ PATH: "/usr/bin" })).toBe(1);
    expect(stderr()).toContain("CV_TEST_ENV_DIR is required");
    expect(calls()).not.toHaveBeenCalled();
  });

  it("rejects the repository, a path inside it, and env files that resolve into it", async () => {
    expect(await start({ CV_TEST_ENV_DIR: repo() })).toBe(1);
    mkdirSync(join(repo(), "sub"));
    expect(await start({ CV_TEST_ENV_DIR: join(repo(), "sub") })).toBe(1);
    rmSync(join(ext(), ".env"));
    symlinkSync(join(repo(), ".env"), join(ext(), ".env"));
    expect(await start(parentEnv())).toBe(1);
    expect(stderr()).toContain("resolves into the repository");
    expect(calls()).not.toHaveBeenCalled();
  });

  it.each(Object.keys(TEST))("fails when %s is missing", async (key) => {
    const { [key]: _gone, ...rest } = TEST;
    setup(rest);
    expect(await start(parentEnv())).toBe(1);
    expect(stderr()).toContain(`${key} is missing`);
    expect(calls()).not.toHaveBeenCalled();
  });

  it.each([
    ["DATABASE_URL", "not a url", "malformed"],
    ["DATABASE_URL", "mysql://a:b@127.0.0.1:55433/x", "malformed"],
    ["REDIS_URL", "redis://:pw@10.0.0.5:56379", "not a loopback"],
    ["S3_ENDPOINT", "http://s3.example.com:58333", "not a loopback"],
    ["S3_ENDPOINT", "http://127.0.0.1", "explicit port"],
    ["REDIS_URL", "redis://127.0.0.1:56379", "needs a password"],
    ["DATABASE_FIXTURE_URL", db("fixture", 55434), "one database"],
    ["API_HOST", "0.0.0.0", "not loopback"],
  ])("rejects %s=%s", async (key, value, reason) => {
    setup({ ...TEST, [key]: value });
    expect(await start(parentEnv())).toBe(1);
    expect(stderr()).toContain(reason);
    expect(calls()).not.toHaveBeenCalled();
  });

  it.each([
    ["DATABASE_URL", "postgres://app:test-pw@127.0.0.1:5432/contextvault", "development endpoint"],
    ["REDIS_URL", "redis://:test@127.0.0.1:6379", "development endpoint"],
    ["S3_ENDPOINT", "http://127.0.0.1:8333", "development endpoint"],
    ["S3_SECRET_ACCESS_KEY", DEV.S3_SECRET_ACCESS_KEY, "development credential"],
    ["REDIS_URL", "redis://:dev-redis@127.0.0.1:56379", "development credential"],
  ])("rejects a development match in %s", async (key, value, reason) => {
    setup({ ...TEST, [key]: value });
    expect(await start(parentEnv())).toBe(1);
    expect(stderr()).toContain(reason);
    expect(calls()).not.toHaveBeenCalled();
  });

  it("rejects an endpoint the repository's own .env uses, whatever its port", async () => {
    write(repo(), ".env", { ...DEV, S3_ENDPOINT: "http://127.0.0.1:58333" });
    expect(await start(parentEnv())).toBe(1);
    expect(stderr()).toContain("S3_ENDPOINT matches a development endpoint");
  });
});

describe("verification", () => {
  it.each([
    ["missing", null, "marker is missing"],
    ["empty", "", "marker is missing"],
    ["mismatched", "dev-database", "marker does not match"],
  ])("a %s PostgreSQL marker blocks the child", async (_name, marker, reason) => {
    const probes = { ...okProbes(), postgres: vi.fn(async () => marker) };
    expect(await start(parentEnv(), probes)).toBe(1);
    expect(stderr()).toContain(reason);
    expect(probes.redis).not.toHaveBeenCalled();
    expect(calls()).not.toHaveBeenCalled();
  });

  it.each(["postgres", "redis", "s3"])("a failing %s check blocks the child", async (name) => {
    const probes = okProbes();
    probes[name] = vi.fn(async () => {
      throw new Error("password authentication failed for user app at 127.0.0.1");
    });
    expect(await start(parentEnv(), probes)).toBe(1);
    expect(stderr()).toContain(`${name} check failed`);
    expect(calls()).not.toHaveBeenCalled();
  });

  it("treats a hung check as a failure", async () => {
    const probes = { ...okProbes(), redis: () => new Promise(() => {}) };
    expect(await start(parentEnv(), probes)).toBe(1);
    expect(stderr()).toContain("redis check failed (timed out)");
    expect(calls()).not.toHaveBeenCalled();
  });

  it("never prints a secret or a credentialed URL, even from a failing probe", async () => {
    const probes = {
      ...okProbes(),
      s3: async () => {
        throw new Error(`${TEST.S3_SECRET_ACCESS_KEY} ${TEST.DATABASE_URL}`);
      },
    };
    await start(parentEnv(), probes);
    setup({ ...TEST, DATABASE_URL: DEV.DATABASE_URL });
    await start(parentEnv());
    for (const secret of [
      TEST.S3_SECRET_ACCESS_KEY,
      "test-pw-app",
      "test-redis-pw",
      "dev-pw",
      DEV.S3_SECRET_ACCESS_KEY,
    ]) {
      expect(stderr()).not.toContain(secret);
    }
  });
});

describe("child environment", () => {
  it("drops inherited development variables and keeps only platform names", () => {
    const parent = {
      PATH: "/usr/bin",
      HOME: "/home/u",
      DATABASE_URL: DEV.DATABASE_URL,
      REDIS_URL: DEV.REDIS_URL,
      PGPASSWORD: "dev-pg",
      PGHOST: "dev-host",
      AWS_ACCESS_KEY_ID: "dev-aws",
      AWS_PROFILE: "dev",
      S3_SECRET_ACCESS_KEY: DEV.S3_SECRET_ACCESS_KEY,
      NODE_OPTIONS: "--env-file=.env",
      API_INTERNAL_URL: "http://dev:3001",
    };
    const env = buildChildEnv(TEST, parent, repo());
    expect(env.DATABASE_URL).toBe(TEST.DATABASE_URL);
    expect(env.REDIS_URL).toBe(TEST.REDIS_URL);
    expect(env.S3_SECRET_ACCESS_KEY).toBe(TEST.S3_SECRET_ACCESS_KEY);
    for (const name of [
      "PGPASSWORD",
      "PGHOST",
      "AWS_ACCESS_KEY_ID",
      "AWS_PROFILE",
      "NODE_OPTIONS",
    ]) {
      expect(env).not.toHaveProperty(name);
    }
    expect(env.API_INTERNAL_URL).toBe(TEST.API_INTERNAL_URL);
    expect(env.NODE_ENV).toBe("test");
    expect(env.POSTGRES_PASSWORD).toBe("");
    expect(env.CV_TEST_STACK_VERIFIED).toBe("1");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/u");
  });

  it("carries over only names the repository declares", () => {
    write(ext(), ".env.test", { NODE_OPTIONS: "--require /x", NODE_ENV: "test" });
    const verified = loadTestEnv(ext(), repo());
    expect(verified).not.toHaveProperty("NODE_OPTIONS");
    expect(verified.NODE_ENV).toBe("test");
  });

  it("hands the rebuilt environment to the child", async () => {
    await start(parentEnv({ DATABASE_URL: DEV.DATABASE_URL, AWS_PROFILE: "dev" }));
    const [command, args, env, cwd] = calls().mock.calls[0];
    expect([command, args, cwd]).toEqual(["echo", ["hi"], repo()]);
    expect(env.DATABASE_URL).toBe(TEST.DATABASE_URL);
    expect(env).not.toHaveProperty("AWS_PROFILE");
    expect(env).not.toHaveProperty("CV_TEST_ENV_DIR");
  });
});
