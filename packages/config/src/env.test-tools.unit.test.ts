import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  EnvError,
  loadBootstrapEnv,
  loadFixtureEnv,
  parseBootstrapEnv,
  parseFixtureEnv,
} from "./env";

const SECRET = "s3cr3t-do-not-leak";
const FIXTURE = { DATABASE_FIXTURE_URL: `postgres://fixture:${SECRET}@127.0.0.1:5432/db` };
const BOOTSTRAP = { DATABASE_BOOTSTRAP_URL: `postgresql://boot:${SECRET}@127.0.0.1:5432/db` };
const APP = { DATABASE_URL: `postgres://app:${SECRET}@127.0.0.1:5432/db` };
const root = new URL("../../../", import.meta.url).pathname;

describe.each([
  ["parseFixtureEnv", parseFixtureEnv, FIXTURE, "DATABASE_FIXTURE_URL"],
  ["parseBootstrapEnv", parseBootstrapEnv, BOOTSTRAP, "DATABASE_BOOTSTRAP_URL"],
] as const)("%s", (_name, parse, valid, name) => {
  it("returns only its own URL", () => {
    expect(parse({ NODE_ENV: "test", ...valid, ...APP, ...FIXTURE, ...BOOTSTRAP })).toEqual(valid);
  });

  it("never falls back to DATABASE_URL or the other test URL", () => {
    for (const other of [APP, FIXTURE, BOOTSTRAP].filter((o) => !(name in o))) {
      expect(() => parse({ NODE_ENV: "test", ...other })).toThrow(new RegExp(`- ${name}:`));
    }
  });

  it.each([undefined, "", `mysql://u:${SECRET}@h/db`, `not a url ${SECRET}`])(
    "rejects %s without echoing it",
    (value) => {
      const run = () => parse({ NODE_ENV: "test", [name]: value });
      expect(run).toThrow(EnvError);
      expect(run).toThrow(new RegExp(`- ${name}:`));
      expect(run).not.toThrow(SECRET);
    },
  );

  it("refuses NODE_ENV=production without echoing the URL", () => {
    const run = () => parse({ NODE_ENV: "production", ...valid });
    expect(run).toThrow(/NODE_ENV: Refused in production/);
    expect(run).not.toThrow(SECRET);
  });

  it("accepts development and rejects a missing NODE_ENV", () => {
    expect(parse({ NODE_ENV: "development", ...valid })).toEqual(valid);
    expect(() => parse(valid)).toThrow(/- NODE_ENV:/);
  });
});

describe("loadFixtureEnv and loadBootstrapEnv", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("read only the ambient environment", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DATABASE_URL", APP.DATABASE_URL);
    expect(() => loadFixtureEnv()).toThrow(/DATABASE_FIXTURE_URL/);
    vi.stubEnv("DATABASE_FIXTURE_URL", FIXTURE.DATABASE_FIXTURE_URL);
    vi.stubEnv("DATABASE_BOOTSTRAP_URL", BOOTSTRAP.DATABASE_BOOTSTRAP_URL);
    expect(loadFixtureEnv()).toEqual(FIXTURE);
    expect(loadBootstrapEnv()).toEqual(BOOTSTRAP);
  });
});

describe("loading boundaries", () => {
  const dir = mkdtempSync(join(tmpdir(), "envtest-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const probe = (args: string[]) =>
    execFileSync(
      process.execPath,
      [...args, "-p", "process.env.DATABASE_FIXTURE_URL ?? 'absent'"],
      { env: {}, encoding: "utf8", cwd: dir },
    ).trim();

  it("a child sees .env.test only when it names the file, and a missing file is fine", () => {
    writeFileSync(join(dir, ".env.test"), "DATABASE_FIXTURE_URL=from-file\n");
    expect(probe(["--env-file-if-exists=.env.test"])).toBe("from-file");
    expect(probe(["--env-file-if-exists=.env"])).toBe("absent");
    expect(probe(["--env-file-if-exists=.env.missing"])).toBe("absent");
  });

  it("an empty process value beats an --env-file-if-exists value", () => {
    writeFileSync(join(dir, ".env.test"), "DATABASE_FIXTURE_URL=from-file\n");
    const out = execFileSync(
      process.execPath,
      ["--env-file-if-exists=.env.test", "-p", "JSON.stringify(process.env.DATABASE_FIXTURE_URL)"],
      {
        env: { DATABASE_FIXTURE_URL: "" },
        encoding: "utf8",
        cwd: dir,
      },
    );
    expect(out.trim()).toBe('""');
  });

  it("only test commands name .env.test", () => {
    const read = (file: string) => readFileSync(join(root, file), "utf8");
    const scripts = z
      .object({ scripts: z.record(z.string(), z.string()) })
      .parse(JSON.parse(read("package.json"))).scripts;
    expect(Object.keys(scripts).filter((k) => scripts[k]?.includes(".env.test"))).toEqual([
      "test:integration",
    ]);
    for (const file of [
      "scripts/dev.mjs",
      "packages/db/package.json",
      "scripts/checks/infra-smoke.mjs",
    ]) {
      expect(read(file)).not.toContain(".env.test");
    }
    // E2E helpers take the stack verified by scripts/checks/with-test-stack.mjs from the process
    // environment; naming an env file would let the repository's development values in.
    for (const file of ["apps/web/e2e/support.ts", "apps/web/e2e/upload-api-support.ts"]) {
      expect(read(file)).not.toContain("--env-file");
    }
  });

  it("git ignores .env.test and tracks .env.test.example", () => {
    const ignored = (path: string) => {
      try {
        execFileSync("git", ["-C", root, "check-ignore", "-q", path]);
        return true;
      } catch {
        return false;
      }
    };
    expect(ignored(".env.test")).toBe(true);
    expect(ignored(".env.test.example")).toBe(false);
  });
});
