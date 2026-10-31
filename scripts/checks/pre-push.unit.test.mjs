import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const hookPath = join(import.meta.dirname, "..", "..", ".githooks", "pre-push");
const hook = readFileSync(hookPath, "utf8");
const GATES = ["format:check", "lint", "arch", "dead-code", "db:check", "typecheck", "test"];
const ORDER = [
  "scripts/git/conventions.mjs",
  "scripts/checks/docs-check.mjs",
  "scripts/checks/tracked-files.mjs",
  "with-test-stack.mjs true",
  ...GATES.map((g) => `pnpm run ${g}`),
  "with-test-stack.mjs pnpm run db:migrate",
  "with-test-stack.mjs pnpm run test:integration",
  "with-test-stack.mjs env NODE_ENV=production pnpm run build",
  "with-test-stack.mjs pnpm run test:e2e",
];
let dir;

// Stub `node` and `pnpm` log each call with its NODE_ENV; FAIL_ON makes the matching call exit 1.
function run({ envDir = "/cv-test-env", failOn = "" } = {}) {
  dir = mkdtempSync(join(tmpdir(), "pre-push-"));
  const log = join(dir, "calls.log");
  for (const name of ["node", "pnpm"]) {
    const file = join(dir, name);
    writeFileSync(
      file,
      `#!/bin/sh\necho "${name} $* | NODE_ENV=\${NODE_ENV:-}" >> "${log}"\nif [ -n "$FAIL_ON" ]; then case "${name} $*" in *"$FAIL_ON"*) exit 1;; esac; fi\n`,
    );
    chmodSync(file, 0o755);
  }
  const env = { PATH: `${dir}:/usr/bin:/bin`, FAIL_ON: failOn };
  if (envDir) env.CV_TEST_ENV_DIR = envDir;
  const result = spawnSync("sh", [hookPath], { env, encoding: "utf8" });
  let calls = [];
  try {
    calls = readFileSync(log, "utf8").trim().split("\n");
  } catch {}
  return { result, calls };
}

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("pre-push hook", () => {
  it("blocks before any infrastructure call when CV_TEST_ENV_DIR is missing", () => {
    const { result, calls } = run({ envDir: "" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("CV_TEST_ENV_DIR is required");
    expect(calls.some((c) => c.includes("with-test-stack"))).toBe(false);
    expect(calls.some((c) => c.startsWith("pnpm"))).toBe(false);
  });

  it("runs every gate in order, infrastructure steps through the wrapper", () => {
    const { result, calls } = run();
    expect(result.status).toBe(0);
    expect(calls).toHaveLength(ORDER.length);
    ORDER.forEach((fragment, i) => {
      expect(calls[i]).toContain(fragment);
    });
    for (const step of ["db:migrate", "test:integration", "build", "test:e2e"]) {
      const bare = calls.filter((c) => c.startsWith(`pnpm run ${step} `));
      expect(bare).toEqual([]);
    }
  });

  it("applies NODE_ENV=production to the build argument only", () => {
    const { calls } = run();
    expect(calls.filter((c) => c.includes("NODE_ENV=production"))).toHaveLength(1);
    expect(calls.every((c) => c.endsWith("| NODE_ENV="))).toBe(true);
    expect(hook.match(/NODE_ENV/g)).toHaveLength(2); // comment + build line
    expect(hook).not.toMatch(/export\s+NODE_ENV/);
  });

  it.each(ORDER.map((fragment, i) => [fragment, i]))(
    "a failure at %s stops later steps",
    (fragment, i) => {
      const { result, calls } = run({ failOn: fragment.replace("with-test-stack.mjs ", "") });
      expect(result.status).not.toBe(0);
      expect(calls.length).toBeLessThanOrEqual(i + 1);
    },
  );

  it("has no development infra, direct migrate, env fallback, git mutation or container control", () => {
    expect(hook).not.toMatch(/infra:ps|infra:up|infra:down|docker/);
    expect(hook).not.toMatch(/^\s*pnpm run db:migrate/m);
    expect(hook).not.toMatch(/\.env/);
    expect(hook).not.toMatch(/git (add|commit|push|reset|stash)|--no-verify|\|\| true|if-present/);
  });
});
