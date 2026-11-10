// Shared fixtures of the with-test-stack unit tests: a fake repository holding development
// values, an external directory holding the test stack, and fake probes. Nothing here touches a
// real service.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { main } from "./with-test-stack.mjs";

export const dump = (values) =>
  Object.entries(values)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
export const db = (user, port = 55433) =>
  `postgres://${user}:test-pw-${user}@127.0.0.1:${port}/contextvault`;
export const TEST = {
  DATABASE_URL: db("app"),
  DATABASE_WORKER_URL: db("worker"),
  DATABASE_MIGRATION_URL: db("owner"),
  DATABASE_FIXTURE_URL: db("fixture"),
  DATABASE_BOOTSTRAP_URL: db("boot"),
  REDIS_URL: "redis://:test-redis-pw@127.0.0.1:56379",
  S3_ENDPOINT: "http://127.0.0.1:58333",
  S3_REGION: "us-east-1",
  S3_BUCKET: "contextvault-test",
  S3_ACCESS_KEY_ID: "test-key-id",
  S3_SECRET_ACCESS_KEY: "test-secret-value",
  NODE_ENV: "test",
  API_INTERNAL_URL: "http://127.0.0.1:3201",
  API_PORT: "3201",
  API_HOST: "127.0.0.1",
  WEB_ORIGIN: "http://127.0.0.1:3100",
  TRUSTED_PROXY_HOPS: "0",
  CV_TEST_DB_MARKER: "cv-test:marker-1",
};
export const DEV = {
  DATABASE_URL: "postgres://app:dev-pw@127.0.0.1:5432/contextvault",
  REDIS_URL: "redis://:dev-redis@127.0.0.1:6379",
  S3_ENDPOINT: "http://127.0.0.1:8333",
  S3_SECRET_ACCESS_KEY: "dev-s3-secret",
  S3_BUCKET: "contextvault-dev",
  POSTGRES_PASSWORD: "dev-superuser-pw",
};

export const okProbes = () => ({
  postgres: vi.fn(async () => TEST.CV_TEST_DB_MARKER),
  redis: vi.fn(async () => {}),
  s3: vi.fn(async () => {}),
});

/** Registers per-test setup and returns the helpers; `repo` and `ext` are read at call time. */
export function useStack() {
  const state = { repo: "", ext: "", calls: vi.fn() };
  const write = (dir, name, values) => writeFileSync(join(dir, name), dump(values));
  const setup = (test = TEST, files = { ".env": test }) => {
    for (const [name, values] of Object.entries(files)) write(state.ext, name, values);
  };
  const start = (parent, probes = okProbes(), extra = {}) => {
    state.calls = vi.fn(async () => 0);
    return main(extra.command ?? ["echo", "hi"], parent, {
      repoRoot: state.repo,
      probes,
      run: state.calls,
      timeoutMs: 50,
      ...extra,
    });
  };
  beforeEach(() => {
    state.repo = mkdtempSync(join(tmpdir(), "wts-repo-"));
    state.ext = mkdtempSync(join(tmpdir(), "wts-ext-"));
    write(state.repo, ".env", DEV);
    write(state.repo, ".env.example", {
      ...Object.fromEntries(Object.keys(DEV).map((k) => [k, "x"])),
      NODE_ENV: "x",
    });
    setup(TEST, { ".env": TEST, ".env.test": {} });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    rmSync(state.repo, { recursive: true, force: true });
    rmSync(state.ext, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
  return {
    state,
    write,
    setup,
    start,
    parentEnv: (extra = {}) => ({ CV_TEST_ENV_DIR: state.ext, PATH: "/usr/bin", ...extra }),
    stderr: () => console.error.mock.calls.flat().join("\n"),
  };
}
