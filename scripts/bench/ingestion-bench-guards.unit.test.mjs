import { describe, expect, it } from "vitest";
import { assertIsolated, assertWorkerRole, isolateEnv } from "./ingestion-bench-guards.mjs";

const MARKER = "ingbench-1";
const urls = {
  app: "postgresql://a:p@127.0.0.1:55001/cv_ingbench_x",
  fixture: "postgresql://f:p@127.0.0.1:55001/cv_ingbench_x",
  worker: "postgresql://w:p@127.0.0.1:55001/cv_ingbench_x",
};
const REDIS = "redis://127.0.0.1:55002";

/** A pg client that answers the catalog queries the guards make. */
const pg = ({
  marker = MARKER,
  name = "contextvault_worker",
  bypass = false,
  timeout = "15s",
} = {}) => ({
  query: async (text) => {
    if (text.includes("shobj_description")) return { rows: [{ marker }] };
    if (text.includes("pg_roles"))
      return { rows: [{ name, rolsuper: false, rolbypassrls: bypass }] };
    return { rows: [{ statement_timeout: timeout }] };
  },
});
const redis = ({ marker = MARKER, size = 1 } = {}) => ({
  get: async () => marker,
  dbsize: async () => size,
});
const base = () => ({
  urls,
  marker: MARKER,
  fixture: pg(),
  workerRole: pg(),
  redis: redis(),
  redisUrl: REDIS,
});

describe("isolateEnv", () => {
  it("drops every foreign connection variable, keeps the rest, and sets only the given ones", () => {
    const env = {
      DATABASE_URL: "dev",
      DATABASE_OWNER_URL: "dev",
      REDIS_URL: "dev",
      S3_BUCKET: "b",
      CV_TEST_ENV_DIR: "x",
      PATH: "/bin",
      HOME: "/h",
    };
    const removed = isolateEnv(env, { DATABASE_URL: "bench" });
    expect(env).toEqual({ DATABASE_URL: "bench", PATH: "/bin", HOME: "/h" });
    expect(removed.sort()).toEqual([
      "CV_TEST_ENV_DIR",
      "DATABASE_OWNER_URL",
      "DATABASE_URL",
      "REDIS_URL",
      "S3_BUCKET",
    ]);
  });
});

describe("assertWorkerRole", () => {
  it("accepts the unprivileged worker role under the production timeout", async () => {
    await expect(assertWorkerRole(pg())).resolves.toBeUndefined();
  });
  it.each([
    ["another role", { name: "contextvault_owner" }, /not contextvault_worker/],
    ["an RLS bypass", { bypass: true }, /bypasses RLS/],
    ["another statement timeout", { timeout: "0" }, /statement_timeout/],
  ])("refuses %s", async (_, over, message) => {
    await expect(assertWorkerRole(pg(over))).rejects.toThrow(message);
  });
});

describe("assertIsolated", () => {
  it("accepts the benchmark's own stack", async () => {
    await expect(assertIsolated(base())).resolves.toBeUndefined();
  });
  it.each([
    [
      "a development database port",
      { urls: { ...urls, fixture: urls.fixture.replace("55001", "5432") } },
      /non-development port/,
    ],
    [
      "a non-loopback database",
      { urls: { ...urls, app: urls.app.replace("127.0.0.1", "db.internal") } },
      /loopback/,
    ],
    [
      "a worker URL naming another database",
      { urls: { ...urls, worker: urls.worker.replace("cv_ingbench_x", "contextvault") } },
      /one database/,
    ],
    ["a database without this run's marker", { fixture: pg({ marker: "kwexp-other" }) }, /marker/],
    [
      "a worker connection without this run's marker",
      { workerRole: pg({ marker: null }) },
      /marker/,
    ],
    ["a privileged worker", { workerRole: pg({ bypass: true }) }, /bypasses RLS/],
    [
      "the development redis port",
      { redisUrl: "redis://127.0.0.1:6379" },
      /redis is not a loopback/,
    ],
    ["a remote redis", { redisUrl: "redis://cache.internal:55002" }, /redis is not a loopback/],
    ["a redis without this run's marker", { redis: redis({ marker: "other" }) }, /redis identity/],
    ["a redis holding other keys", { redis: redis({ size: 40 }) }, /keys this run did not create/],
  ])("refuses %s", async (_, over, message) => {
    await expect(assertIsolated({ ...base(), ...over })).rejects.toThrow(message);
  });
});
