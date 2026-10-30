import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseApiEnv, parseWorkerEnv } from "../packages/config/src/env.ts";
import { ALLOWLISTS, buildEnv, PLATFORM, readDotEnv } from "./run-with-env.mjs";

const API = [
  "NODE_ENV",
  "API_PORT",
  "API_HOST",
  "WEB_ORIGIN",
  "TRUSTED_PROXY_HOPS",
  "DATABASE_URL",
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
];
const PRIVILEGED = [
  "DATABASE_MIGRATION_URL",
  "DATABASE_FIXTURE_URL",
  "DATABASE_BOOTSTRAP_URL",
  "POSTGRES_PASSWORD",
  "POSTGRES_APP_PASSWORD",
  "POSTGRES_OWNER_PASSWORD",
  "POSTGRES_FIXTURE_PASSWORD",
  "REDIS_PASSWORD",
];
const fake = (names) => Object.fromEntries(names.map((name) => [name, `fake-${name}`]));
const dotEnv = (values) =>
  Object.entries(values)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

// The launcher finds `.env` next to its own directory's parent, so a copy inside a temp tree reads
// that tree's `.env` and never the real one.
let root;
let probe;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "run-with-env-"));
  mkdirSync(join(root, "scripts"));
  copyFileSync(new URL("./run-with-env.mjs", import.meta.url), join(root, "scripts/launcher.mjs"));
  probe = join(root, "probe.mjs");
  // Reports only PASS or FAIL: `env <json>` checks the exact name/value set, `exit <n>` exits.
  // Signal behaviour is tested in run-with-env.lifecycle.unit.test.mjs.
  writeFileSync(
    probe,
    `const [mode, arg] = process.argv.slice(2);
if (mode === "env") {
  const want = JSON.parse(arg);
  // macOS adds __CF_USER_TEXT_ENCODING to every process it starts; it is not the launcher's doing.
  const got = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "__CF_USER_TEXT_ENCODING"));
  const ok = Object.keys(got).length === Object.keys(want).length &&
    Object.entries(want).every(([k, v]) => got[k] === v);
  console.log(ok ? "PASS" : "FAIL");
} else if (mode === "exit") process.exit(Number(arg));
else process.exit(64);
`,
  );
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const launcher = () => join(root, "scripts/launcher.mjs");
const setDotEnv = (values) => {
  if (values === null) rmSync(join(root, ".env"), { force: true });
  else writeFileSync(join(root, ".env"), dotEnv(values));
};
const launch = (app, parent, ...args) =>
  spawnSync(process.execPath, [launcher(), app, probe, ...args], {
    env: parent,
    encoding: "utf8",
  });
const BASE = { PATH: "/usr/bin" };

describe("allowlists", () => {
  it("api is exactly the approved names", () => {
    expect(ALLOWLISTS.api).toEqual(API);
    expect(buildEnv("api", fake(API), {})).toEqual(fake(API));
  });

  it("worker is exactly NODE_ENV, REDIS_URL and DATABASE_WORKER_URL", () => {
    const WORKER = ["NODE_ENV", "REDIS_URL", "DATABASE_WORKER_URL"];
    expect(ALLOWLISTS.worker).toEqual(WORKER);
    const file = fake([...API, ...PRIVILEGED, "REDIS_URL", "DATABASE_WORKER_URL"]);
    expect(buildEnv("worker", file, {})).toEqual(fake(WORKER));
  });

  it("excludes every privileged variable for both apps", () => {
    const file = fake([...API, ...PRIVILEGED, "REDIS_URL"]);
    const parent = fake(PRIVILEGED);
    for (const app of ["api", "worker"]) {
      const env = buildEnv(app, file, parent);
      for (const name of PRIVILEGED) expect(env).not.toHaveProperty(name);
    }
    expect(buildEnv("api", file, parent)).not.toHaveProperty("REDIS_URL");
  });
});

// .env.example is the committed contract: its placeholder values are fake and `.env` is never read.
describe("contract", () => {
  const example = parseEnv(readFileSync(new URL("../.env.example", import.meta.url), "utf8"));

  it.each(["api", "worker"])("every %s name is declared in .env.example", (app) => {
    for (const name of ALLOWLISTS[app]) expect(example).toHaveProperty(name);
  });

  it("allowlists no privileged administrative variable", () => {
    const allowed = new Set([...ALLOWLISTS.api, ...ALLOWLISTS.worker, ...PLATFORM]);
    for (const name of PRIVILEGED) expect(allowed.has(name)).toBe(false);
  });

  it("builds an environment the api and worker loaders accept", () => {
    expect(parseApiEnv(buildEnv("api", example, {})).API_PORT).toBe(3001);
    expect(parseWorkerEnv(buildEnv("worker", example, {})).REDIS_URL).toMatch(/^redis:/);
  });

  it("builds environments the loaders refuse once a required name is missing", () => {
    const { DATABASE_URL: _dropped, ...rest } = example;
    expect(() => parseApiEnv(buildEnv("api", rest, {}))).toThrow(/DATABASE_URL/);
  });
});

describe("values", () => {
  it("prefers the parent over the file, including an empty string", () => {
    const file = { NODE_ENV: "development", DATABASE_URL: "from-file", API_HOST: "file-host" };
    const env = buildEnv("api", file, { NODE_ENV: "test", DATABASE_URL: "" });
    expect(env).toEqual({ NODE_ENV: "test", DATABASE_URL: "", API_HOST: "file-host" });
  });

  it("takes platform names from the parent only, never from the file", () => {
    const file = { PATH: "/from/file", HOME: "/h", TMPDIR: "/file-tmp" };
    const parent = { PATH: "/usr/bin", HOME: "/home/u", TMPDIR: "/tmp/u" };
    expect(PLATFORM).toEqual(["PATH", "TMPDIR"]);
    expect(buildEnv("worker", file, parent)).toEqual({ PATH: "/usr/bin", TMPDIR: "/tmp/u" });
    expect(buildEnv("worker", file, {})).toEqual({});
  });

  it("treats a missing .env as empty and rethrows other read errors", () => {
    expect(readDotEnv(join(root, "no-such-file"))).toEqual({});
    expect(() => readDotEnv(root)).toThrow();
  });
});

describe("child process", () => {
  it("gets the allowlist, the platform names and nothing else", () => {
    const names = ["NODE_ENV", "REDIS_URL"];
    setDotEnv({ ...fake(names), ...fake(PRIVILEGED), HOME: "/file-home" });
    const parent = {
      ...BASE,
      TMPDIR: "/tmp/probe",
      HOME: "/home/probe",
      AWS_SECRET_ACCESS_KEY: "x",
      DATABASE_URL: "x",
      ...fake(PRIVILEGED),
    };
    const want = { ...fake(names), PATH: BASE.PATH, TMPDIR: "/tmp/probe" };
    const result = launch("worker", parent, "env", JSON.stringify(want));
    expect(result.stdout.trim()).toBe("PASS");
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("gets the api allowlist from the file and parent together", () => {
    setDotEnv({ ...fake(API.slice(1)), ...fake(PRIVILEGED) });
    const want = { ...fake(API), PATH: BASE.PATH };
    const result = launch(
      "api",
      { ...BASE, NODE_ENV: "fake-NODE_ENV" },
      "env",
      JSON.stringify(want),
    );
    expect(result.stdout.trim()).toBe("PASS");
  });

  it("starts with no .env at all", () => {
    setDotEnv(null);
    const want = { NODE_ENV: "development", PATH: BASE.PATH };
    const result = launch(
      "worker",
      { ...BASE, NODE_ENV: "development" },
      "env",
      JSON.stringify(want),
    );
    expect(result.stdout.trim()).toBe("PASS");
  });

  it("shows only an error code, never a value, when the environment cannot be applied", () => {
    setDotEnv({ DATABASE_URL: "postgres://user:hunter2@host/db\u0000" });
    const result = launch("api", BASE, "exit", "0");
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe(
      "run-with-env: could not start the entry (ERR_INVALID_ARG_VALUE)",
    );
  });

  it("propagates the exit code", () => {
    setDotEnv(null);
    for (const code of [0, 3, 7])
      expect(launch("api", BASE, "exit", String(code)).status).toBe(code);
  });

  it("rejects an unknown app or a missing entry with status 2", () => {
    const bad = spawnSync(process.execPath, [launcher(), "other", probe], { env: BASE });
    const none = spawnSync(process.execPath, [launcher(), "api"], { env: BASE });
    expect([bad.status, none.status]).toEqual([2, 2]);
  });

  // Each entry would run code or load `.env` if Node saw it as a flag; none may reach execve, so
  // nothing is printed by the script and the only output is the fixed usage line.
  it.each(["--env-file=.env", "--eval=console.log(1)", "--require=x", "-p", "-e", "-", "--"])(
    "refuses the flag-like entry %s before executing anything",
    (entry) => {
      setDotEnv(fake(PRIVILEGED));
      const run = spawnSync(process.execPath, [launcher(), "api", entry, "console.log('RAN')"], {
        cwd: root,
        env: BASE,
        encoding: "utf8",
      });
      expect(run.status).toBe(2);
      expect(run.stdout).toBe("");
      expect(run.stderr.trim()).toBe(
        "usage: run-with-env.mjs <api|worker|web> <entry.mjs> [args...]",
      );
    },
  );

  it("still runs a relative entry and forwards its arguments", () => {
    setDotEnv(null);
    const run = spawnSync(process.execPath, [launcher(), "api", "./probe.mjs", "exit", "5"], {
      cwd: root,
      env: BASE,
    });
    expect(run.status).toBe(5);
  });
});
