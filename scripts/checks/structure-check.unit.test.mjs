import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findProblems, LEGACY_FILES } from "./structure-check.mjs";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const script = join(repo, "scripts/checks/structure-check.mjs");
const none = new Set();
const OK = "apps/api/src/documents/integration/a.integration.test.ts";

describe("findProblems", () => {
  it("accepts feature-owned and nested integration directories", () => {
    const files = [
      OK,
      "apps/api/src/documents/integration/uploads/b.integration.test.ts",
      "packages/db/src/integration/rls/c.integration.test.ts",
    ];
    expect(findProblems(files, none)).toEqual([]);
  });

  it("rejects an integration test beside source", () => {
    const problems = findProblems([OK, "apps/api/src/documents/a.integration.test.ts"], none);
    expect(problems).toHaveLength(1);
  });

  it("rejects a flat catch-all integration directory at the workspace root", () => {
    const problems = findProblems([OK, "apps/api/src/integration/a.integration.test.ts"], none);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("catch-all");
  });

  it("rejects integration tests that vitest would never run", () => {
    const files = [OK, "apps/web/src/integration/ui/a.integration.test.tsx"];
    expect(findProblems(files, none)).toHaveLength(1);
  });

  it("tolerates only the exact legacy files", () => {
    const listed = "packages/db/src/a.integration.test.ts";
    const files = [OK, listed, "packages/db/src/b.integration.test.ts"];
    const problems = findProblems(files, new Set([listed]));
    expect(problems).toEqual([expect.stringContaining("packages/db/src/b.integration.test.ts")]);
  });

  it("rejects stale legacy entries: file gone, or already placed correctly", () => {
    const legacy = new Set(["packages/db/src/gone.integration.test.ts", OK]);
    const problems = findProblems([OK], legacy);
    expect(problems).toHaveLength(2);
    expect(problems.join("\n")).toContain("file is gone");
    expect(problems.join("\n")).toContain("now placed correctly");
  });

  it("rejects generic names for files and directories", () => {
    const files = [OK, "apps/api/src/utils/a.ts", "packages/db/src/helpers.ts"];
    expect(findProblems(files, none)).toHaveLength(2);
  });

  it("allows names that merely contain a generic word", () => {
    expect(
      findProblems([OK, "apps/api/src/session-manager.ts", "apps/api/src/shared-types.ts"], none),
    ).toEqual([]);
  });

  it("fails when no source file is scanned", () => {
    expect(
      findProblems(["scripts/utils.mjs", "apps/web/e2e/a.integration.test.ts"], none),
    ).toHaveLength(1);
    expect(findProblems([], none)).toHaveLength(1);
  });

  it("never grows the legacy list", () => {
    // Lower this number when a slice moves files. Raising it means a misplaced test was added.
    expect(LEGACY_FILES.size).toBeLessThanOrEqual(5);
  });
});

describe("structure-check command", () => {
  let dir;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "structure-check-"));
    spawnSync("git", ["init", "-q"], { cwd: dir });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const run = (cwd, ...args) => spawnSync("node", [script, ...args], { cwd, encoding: "utf8" });

  it("passes on this repository from any working directory", () => {
    for (const cwd of [repo, join(repo, "scripts/git"), tmpdir()]) {
      expect(run(cwd).status).toBe(0);
    }
  });

  it("fails on an empty checkout", () => {
    const result = run(dir, dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no source files scanned");
  });

  it("sees untracked files", () => {
    const rel = "apps/x/src/new.integration.test.ts";
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), "");
    const result = run(tmpdir(), dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(rel);
  });
});

// Biome replaces (not merges) noRestrictedImports options per override, so every override that
// governs production code must carry the integration rule (and, in packages/db, the testing/ rule). Linting files in a scratch copy of the
// config keeps the repository untouched.
describe("production code never imports integration or testing files", () => {
  let dir;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "structure-biome-"));
    const config = JSON.parse(readFileSync(join(repo, "biome.json"), "utf8"));
    config.vcs.enabled = false;
    config.$schema = undefined;
    writeFileSync(join(dir, "biome.json"), JSON.stringify(config));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const lintStatus = (file, specifier) => {
    const path = join(dir, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `import { x } from "${specifier}";\nexport const y = x;\n`);
    const biome = join(repo, "node_modules/.bin/biome");
    const args = ["lint", "--only=style/noRestrictedImports", "--colors=off", file];
    return spawnSync(biome, args, { cwd: dir, encoding: "utf8" }).status;
  };

  it.each([
    ["apps/api/src/documents/a.ts", "./integration/upload-support"],
    ["apps/api/src/auth/a.ts", "../documents/integration/upload-support"],
    ["packages/db/src/a.ts", "./integration/x"],
    ["packages/db/src/a.ts", "./testing/tenant-fixture"],
    ["packages/db/src/provisioning/a.ts", "../testing/tenant-fixture"],
    ["packages/db/src/repositories/ingestion/a.ts", "../../testing/ingestion-test-support"],
    ["packages/db/src/user-create.ts", "./testing/tenant-fixture"],
    ["packages/db/src/a.ts", "./testing"],
    ["packages/db/src/a.ts", "@contextvault/db/testing"],
    ["packages/db/src/a.ts", "@contextvault/db/testing/ingestion"],
    ["packages/db/src/repositories/a.ts", "../testing"],
    ["packages/db/src/user-create.ts", "./testing"],
    ["packages/db/src/e2e-accounts.ts", "@contextvault/db/testing"],
    ["packages/db/src/e2e-accounts.ts", "./testing/document-fixture"],
    ["packages/db/src/e2e-accounts.ts", "./integration/x"],
    ["packages/db/src/provisioning/integration/test-harness.ts", "./integration/x"],
    ["apps/worker/src/a.ts", "./testing/redis-proxy-test-support"],
    ["apps/worker/src/queue/a.ts", "../testing/redis-proxy-test-support"],
    ["apps/worker/src/queue/a.ts", "../testing"],
    ["apps/api/src/documents/a-support.ts", "../testing/test-support"],
    ["apps/api/src/a-support.ts", "./testing/test-support"],
    ["packages/auth/src/a.ts", "./integration/x"],
    ["packages/domain/src/a.ts", "./integration/x"],
    ["packages/contracts/src/a.ts", "./integration/x"],
  ])("rejects %s importing %s", (file, specifier) => {
    expect(lintStatus(file, specifier)).toBe(1);
  });

  it.each([
    ["apps/api/src/documents/b.ts", "./tokens"],
    ["apps/api/src/documents/integration/a.integration.test.ts", "./upload-support"],
    ["apps/api/src/documents/a.unit.test.ts", "./integration/upload-support"],
    ["apps/api/src/a-test-support.ts", "./documents/integration/upload-support"],
    [
      "apps/worker/src/queue/integration/a.integration.test.ts",
      "../../testing/redis-proxy-test-support",
    ],
    ["apps/worker/src/queue/a.unit.test.ts", "../testing/redis-proxy-test-support"],
    ["apps/worker/src/testing/a.ts", "./redis-proxy-test-support"],
    ["packages/db/src/a.integration.test.ts", "./integration/x"],
    ["packages/db/src/a.unit.test.ts", "./integration/x"],
    ["packages/db/src/a-test-support.ts", "./integration/x"],
    ["packages/db/src/a.integration.test.ts", "./testing/tenant-fixture"],
    ["packages/db/src/a.unit.test.ts", "./testing/tenant-fixture"],
    ["packages/db/src/a-test-support.ts", "./testing/tenant-fixture"],
    ["packages/db/src/provisioning/integration/test-harness.ts", "../../testing/tenant-fixture"],
    ["packages/db/src/testing/a.ts", "./tenant-fixture"],
    ["packages/db/src/provisioning/integration/test-harness.ts", "@contextvault/auth"],
    ["packages/db/src/user-create.ts", "@contextvault/auth"],
    ["packages/auth/src/a.unit.test.ts", "./integration/x"],
    ["packages/domain/src/a.unit.test.ts", "./integration/x"],
    ["packages/contracts/src/a.unit.test.ts", "./integration/x"],
  ])("allows %s importing %s", (file, specifier) => {
    expect(lintStatus(file, specifier)).toBe(0);
  });

  // The test-file overrides repeat each package's other restrictions; they must not go slack.
  it.each([
    ["packages/db/src/a.unit.test.ts", "@contextvault/auth"],
    ["packages/db/src/provisioning/cli.ts", "@contextvault/auth"],
    ["packages/auth/src/a.unit.test.ts", "pg"],
    ["packages/domain/src/a.unit.test.ts", "react"],
    ["packages/contracts/src/a-test-support.ts", "bullmq"],
  ])("still applies the package rules to %s importing %s", (file, specifier) => {
    expect(lintStatus(file, specifier)).toBe(1);
  });
});
