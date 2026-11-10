import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEV, TEST, useStack } from "./with-test-stack.fixtures.mjs";

const { state, setup, start, parentEnv, stderr, write } = useStack();
const rejects = async (values, reason, dev = DEV) => {
  write(state.repo, ".env", dev);
  setup({ ...TEST, ...values });
  expect(await start(parentEnv())).toBe(1);
  expect(stderr()).toContain(reason);
  expect(state.calls).not.toHaveBeenCalled();
};

describe("API endpoint", () => {
  it("accepts an isolated API port that API_INTERNAL_URL repeats", async () => {
    expect(await start(parentEnv())).toBe(0);
  });

  it.each([
    [{ API_PORT: "3001" }, "API_PORT is a development port"],
    [{ API_PORT: "3001", API_INTERNAL_URL: "http://127.0.0.1:3001" }, "development endpoint"],
    [{ API_INTERNAL_URL: "http://localhost:3001" }, "development endpoint"],
    [{ API_PORT: "3202" }, "API_PORT and API_INTERNAL_URL disagree"],
    [{ API_PORT: "03201" }, "API_PORT is invalid"],
    [{ API_PORT: "70000" }, "API_PORT is invalid"],
    [{ API_PORT: "http" }, "API_PORT is invalid"],
    [{ API_PORT: "" }, "API_PORT is missing"],
  ])("rejects %j", (values, reason) => rejects(values, reason));

  it("rejects the API port written in the development .env", () =>
    rejects(
      { API_PORT: "3300", API_INTERNAL_URL: "http://127.0.0.1:3300" },
      "API_PORT is a development port",
      { ...DEV, API_PORT: "3300" },
    ));

  it.each(["http://127.0.0.1:3201/", "http://127.0.0.1:3201/v1", "http://user:pw@127.0.0.1:3201"])(
    "rejects API_INTERNAL_URL %s",
    (value) => rejects({ API_INTERNAL_URL: value }, "API_INTERNAL_URL must be a bare origin"),
  );
});

describe("S3", () => {
  it.each([
    "http://127.0.0.1:58333/",
    "http://127.0.0.1:58333/bucket",
    "http://key:secret@127.0.0.1:58333",
  ])("rejects the endpoint %s", (value) =>
    rejects({ S3_ENDPOINT: value }, "S3_ENDPOINT must be a bare origin"),
  );

  it("rejects the bucket of the development .env", () =>
    rejects({ S3_BUCKET: "shared" }, "S3_BUCKET is the development bucket", {
      ...DEV,
      S3_BUCKET: "shared",
    }));

  it("rejects the default bucket of .env.example", () => {
    write(state.repo, ".env.example", { S3_BUCKET: "shared" });
    return rejects({ S3_BUCKET: "shared" }, "S3_BUCKET is the development bucket");
  });
});

describe("credentials", () => {
  it.each([
    "DATABASE_URL",
    "DATABASE_WORKER_URL",
    "DATABASE_MIGRATION_URL",
    "DATABASE_FIXTURE_URL",
    "DATABASE_BOOTSTRAP_URL",
  ])("rejects an empty password in %s", (key) =>
    rejects({ [key]: "postgres://u@127.0.0.1:55433/contextvault" }, `${key} needs a password`),
  );

  it("rejects an explicitly empty password", () =>
    rejects({ DATABASE_URL: "postgres://u:@127.0.0.1:55433/contextvault" }, "needs a password"));
});

describe("paths", () => {
  it("rejects a symlink that leads into the repository", async () => {
    mkdirSync(join(state.repo, "sub"));
    const link = `${state.ext}-link`;
    symlinkSync(join(state.repo, "sub"), link);
    expect(await start({ CV_TEST_ENV_DIR: link })).toBe(1);
    expect(stderr()).toContain("repository or inside it");
  });

  it("rejects a case variant of the repository path", async () => {
    mkdirSync(join(state.repo, "sub"));
    const variant = join(state.repo.toUpperCase(), "sub");
    // Case-insensitive volumes (macOS) resolve it to the real directory; elsewhere it does not exist.
    const insensitive = existsSync(variant);
    expect(await start({ CV_TEST_ENV_DIR: variant })).toBe(1);
    expect(stderr()).toContain(insensitive ? "repository or inside it" : "does not exist");
    expect(state.calls).not.toHaveBeenCalled();
  });
});

describe("child exit status", () => {
  it("reports a signal death as 128 plus the signal number", async () => {
    const status = await start(parentEnv(), undefined, {
      run: undefined,
      command: [process.execPath, "-e", "process.kill(process.pid, 'SIGTERM')"],
    });
    expect(status).toBe(143);
  });
});
