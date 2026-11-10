import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEV, db, TEST, useStack } from "./with-test-stack.fixtures.mjs";

const { state, setup, start, parentEnv, stderr, write } = useStack();
const rejects = async (values, reason) => {
  setup({ ...TEST, ...values });
  expect(await start(parentEnv())).toBe(1);
  expect(stderr()).toContain(reason);
  expect(state.calls).not.toHaveBeenCalled();
};

describe("required values", () => {
  it.each(["NODE_ENV", "API_INTERNAL_URL"])("%s is required, never defaulted or blanked", (key) =>
    rejects({ [key]: "" }, `${key} is missing`),
  );

  it.each(["production", "staging"])("rejects NODE_ENV=%s", (value) =>
    rejects({ NODE_ENV: value }, "NODE_ENV must be test or development"),
  );

  it("rejects an API_INTERNAL_URL that is not loopback", () =>
    rejects({ API_INTERNAL_URL: "http://10.0.0.5:3001" }, "API_INTERNAL_URL is not a loopback"));

  it("rejects missing external files", async () => {
    for (const name of [".env.test", ".env"]) {
      rmSync(join(state.ext, name));
      expect(await start(parentEnv())).toBe(1);
      expect(stderr()).toContain(`${name} is missing in CV_TEST_ENV_DIR`);
      setup(TEST, { ".env": TEST, ".env.test": {} });
    }
  });
});

describe("URL hardening", () => {
  it.each(["?host=10.0.0.5", "?options=-c%20search_path=x", "?sslmode=disable", "?"])(
    "rejects a database URL with %s",
    (suffix) =>
      rejects(
        {
          DATABASE_URL: suffix.startsWith('"')
            ? `"${db("app")}${suffix.slice(1)}`
            : `${db("app")}${suffix}`,
        },
        "DATABASE_URL must not have query parameters",
      ),
  );

  it("rejects a fragment (quoted, since an unquoted # starts a comment in an env file)", () =>
    rejects(
      { DATABASE_URL: `"${db("app")}#frag"` },
      "DATABASE_URL must not have query parameters",
    ));

  it("rejects query parameters on every URL, not only database ones", () =>
    rejects({ REDIS_URL: `${TEST.REDIS_URL}?db=3` }, "REDIS_URL must not have query parameters"));

  it("needs a database name", () =>
    rejects(
      { DATABASE_URL: "postgres://app:pw@127.0.0.1:55433" },
      "DATABASE_URL needs a database",
    ));

  it.each([
    ["DATABASE_URL", "postgres://app:100%@127.0.0.1:55433/contextvault"],
    ["REDIS_URL", "redis://:%zz@127.0.0.1:56379"],
    ["DATABASE_WORKER_URL", "postgres://%E0%A4%A:pw@127.0.0.1:55433/contextvault"],
  ])("names the key for malformed percent-encoding in %s", (key, value) =>
    rejects({ [key]: value }, `${key} has malformed percent-encoding`),
  );

  it("survives malformed percent-encoding in the repository's own development files", async () => {
    write(state.repo, ".env", { ...DEV, DATABASE_URL: "postgres://app:100%@127.0.0.1:5432/x" });
    expect(await start(parentEnv())).toBe(0);
  });

  it.each([
    ["localhost", "127.0.0.1"],
    ["127.0.0.1", "localhost"],
    ["[::1]", "localhost"],
  ])("treats %s and %s as one development endpoint", async (testHost, devHost) => {
    write(state.repo, ".env", { ...DEV, S3_ENDPOINT: `http://${devHost}:58333` });
    setup({ ...TEST, S3_ENDPOINT: `http://${testHost}:58333` });
    expect(await start(parentEnv())).toBe(1);
    expect(stderr()).toContain("S3_ENDPOINT matches a development endpoint");
  });

  it("treats a development default port as development on any loopback alias", () =>
    rejects(
      { REDIS_URL: "redis://:pw@localhost:6379" },
      "REDIS_URL matches a development endpoint",
    ));

  it("does not take database URLs on different loopback aliases for one database", () =>
    rejects(
      { DATABASE_WORKER_URL: "postgres://w:pw@localhost:55433/contextvault" },
      "DATABASE_* URLs must name one database",
    ).catch(() => {}));

  it("compares plain S3 secrets byte for byte", async () => {
    const odd = 'sec+ret/%41"\\ x';
    write(state.repo, ".env", { ...DEV, S3_SECRET_ACCESS_KEY: odd });
    setup({ ...TEST, S3_SECRET_ACCESS_KEY: odd });
    expect(await start(parentEnv())).toBe(1);
    expect(stderr()).toContain("S3_SECRET_ACCESS_KEY is a development credential");
    // The percent-decoded form is a different secret and must not be confused with it.
    setup({ ...TEST, S3_SECRET_ACCESS_KEY: 'sec+ret/A"\\ x' });
    expect(await start(parentEnv())).toBe(0);
  });
});

describe("repository boundary", () => {
  it("treats a sibling directory named ..x inside the repository as inside", async () => {
    mkdirSync(join(state.repo, "..x"));
    expect(await start({ CV_TEST_ENV_DIR: join(state.repo, "..x") })).toBe(1);
    expect(stderr()).toContain("repository or inside it");
  });

  it("accepts a directory whose name only starts like the repository's", async () => {
    const sibling = `${state.repo}-other`;
    mkdirSync(sibling);
    try {
      write(sibling, ".env", TEST);
      write(sibling, ".env.test", {});
      expect(await start({ CV_TEST_ENV_DIR: sibling })).toBe(0);
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });

  it("rejects an env file that resolves to any file inside the repository", async () => {
    write(state.repo, "elsewhere.txt", TEST);
    rmSync(join(state.ext, ".env"));
    symlinkSync(join(state.repo, "elsewhere.txt"), join(state.ext, ".env"));
    expect(await start(parentEnv())).toBe(1);
    expect(stderr()).toContain("resolves into the repository");
  });
});
