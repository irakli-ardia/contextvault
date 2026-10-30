import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseWebEnv } from "../packages/config/src/env.ts";
import { ALLOWLISTS, buildEnv, PLATFORM } from "./run-with-env.mjs";

// Web mode of run-with-env.mjs: the allowlist comes from the parent only, `.env` is never read.
const WEB = ["NODE_ENV", "API_INTERNAL_URL"];
const API = ["DATABASE_URL", "API_PORT", "WEB_ORIGIN", "S3_SECRET_ACCESS_KEY"];
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
const BASE = { PATH: "/usr/bin" };
const fake = (names) => Object.fromEntries(names.map((name) => [name, `fake-${name}`]));

describe("web allowlist", () => {
  it("is exactly NODE_ENV and API_INTERNAL_URL, taken from the parent", () => {
    expect(ALLOWLISTS.web).toEqual(WEB);
    expect(buildEnv("web", {}, fake([...WEB, ...API]))).toEqual(fake(WEB));
    expect(buildEnv("web", {}, { API_INTERNAL_URL: "" })).toEqual({ API_INTERNAL_URL: "" });
  });

  it("holds no privileged name and no platform name", () => {
    for (const name of [...PRIVILEGED, ...PLATFORM]) expect(ALLOWLISTS.web).not.toContain(name);
    const env = buildEnv("web", fake(PRIVILEGED), fake(PRIVILEGED));
    for (const name of PRIVILEGED) expect(env).not.toHaveProperty(name);
  });

  it("builds an environment the web loader accepts", () => {
    const env = buildEnv("web", {}, { API_INTERNAL_URL: "http://127.0.0.1:3199" });
    expect(parseWebEnv(env)).toEqual({ API_INTERNAL_URL: "http://127.0.0.1:3199" });
  });
});

describe("web child process", () => {
  let root;
  let probe;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "run-with-env-web-"));
    mkdirSync(join(root, "scripts"));
    copyFileSync(
      new URL("./run-with-env.mjs", import.meta.url),
      join(root, "scripts/launcher.mjs"),
    );
    probe = join(root, "probe.mjs");
    // Prints its sorted environment names (macOS adds __CF_USER_TEXT_ENCODING itself) and the URL.
    writeFileSync(
      probe,
      `const names = Object.keys(process.env).filter((k) => k !== "__CF_USER_TEXT_ENCODING").sort();
console.log(JSON.stringify({ names, url: process.env.API_INTERNAL_URL }));
`,
    );
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const launch = (parent) => {
    const run = spawnSync(process.execPath, [join(root, "scripts/launcher.mjs"), "web", probe], {
      env: parent,
      encoding: "utf8",
    });
    return { status: run.status, ...JSON.parse(run.stdout || "{}") };
  };

  it("gets the parent's allowlisted names and the platform names, whatever else is polluted", () => {
    const parent = {
      ...BASE,
      TMPDIR: "/tmp/probe",
      HOME: "/h",
      AWS_SECRET_ACCESS_KEY: "fake-aws-secret",
      NODE_OPTIONS: "--no-warnings",
      ...fake([...WEB, ...API, ...PRIVILEGED]),
    };
    const got = launch(parent);
    expect(got.names).toEqual([...WEB, "PATH", "TMPDIR"].sort());
    expect(got.names).not.toContain("AWS_SECRET_ACCESS_KEY");
    expect(got.names).not.toContain("NODE_OPTIONS");
    expect(got.url).toBe("fake-API_INTERNAL_URL");
  });

  it("never reads .env, even with fake allowed values or one that cannot be applied", () => {
    writeFileSync(join(root, ".env"), [...WEB, ...PRIVILEGED].map((k) => `${k}=file`).join("\n"));
    expect(launch(BASE)).toEqual({ status: 0, names: ["PATH"] });
    expect(launch({ ...BASE, API_INTERNAL_URL: "http://parent.invalid" }).url).toBe(
      "http://parent.invalid",
    );
    writeFileSync(join(root, ".env"), "DATABASE_URL=x\u0000");
    expect(launch(BASE).status).toBe(0);
  });
});

describe("dev.mjs", () => {
  it.each(["web", "other"])(
    "accepts only api and worker, so %s is refused with status 2",
    (app) => {
      const dev = fileURLToPath(new URL("./dev.mjs", import.meta.url));
      const run = spawnSync(process.execPath, [dev, app], { env: BASE, encoding: "utf8" });
      expect([run.status, run.stdout, run.stderr.trim()]).toEqual([
        2,
        "",
        "usage: dev.mjs <api|worker>",
      ]);
    },
  );
});
