import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importProblems } from "./structure-check.mjs";

const script = fileURLToPath(new URL("./structure-check.mjs", import.meta.url));
const DB = "packages/db/src";
const ROLES = `${DB}/integration/roles/a.integration.test.ts`;
const RECOVERY = `${DB}/integration/recovery/recovery-test-support.ts`;

const check = (file, source) => importProblems([file], () => source);

describe("integration areas import only themselves", () => {
  it.each([
    ["same directory", ROLES, 'import { x } from "./role-test-support";'],
    ["same area, nested", ROLES, 'import { x } from "./deep/more/x";'],
    ["shared workspace testing/", ROLES, 'import { x } from "../../testing/tenant-fixture";'],
    ["production code", ROLES, 'import { x } from "../../client";'],
    ["package import", ROLES, 'import { x } from "@contextvault/db/testing";'],
    ["outside src", ROLES, 'import { x } from "../../../../../infra/x";'],
    [
      "feature integration importing its own support",
      `apps/api/src/documents/integration/a.integration.test.ts`,
      'import { x } from "./upload-support";',
    ],
    ["a local namespace re-export", ROLES, 'export * as ns from "./role-test-support";'],
    ["a local named re-export", ROLES, 'export { x } from "./role-test-support";'],
    ["a shared namespace re-export", ROLES, 'export * as ns from "../../testing/tenant-fixture";'],
    ["an export without a source", ROLES, "const x = 1;\nexport { x };\nexport const y = 2;"],
    ["a comment", ROLES, '// import { x } from "../recovery/recovery-test-support";'],
    ["a plain string", ROLES, 'const s = "../recovery/recovery-test-support";'],
    [
      "not an integration file",
      `${DB}/a.unit.test.ts`,
      'import { x } from "./integration/recovery/x";',
    ],
  ])("allows %s", (_name, file, source) => {
    expect(check(file, source)).toEqual([]);
  });

  it.each([
    ["sibling area", 'import { x } from "../recovery/recovery-test-support";'],
    ["extension kept", 'import { x } from "../recovery/recovery-test-support.ts";'],
    ["detour through ./", 'import { x } from "./../recovery/recovery-test-support";'],
    ["detour through a sibling", 'import { x } from "../roles/../recovery/recovery-test-support";'],
    ["type-only import", 'import type { X } from "../recovery/recovery-test-support";'],
    ["side-effect import", 'import "../recovery/recovery-test-support";'],
    ["re-export", 'export * from "../recovery/recovery-test-support";'],
    ["namespace re-export", 'export * as ns from "../recovery/recovery-test-support";'],
    ["type namespace re-export", 'export type * as ns from "../recovery/recovery-test-support";'],
    ["type-only named re-export", 'export type { X } from "../recovery/recovery-test-support";'],
    ["named re-export", 'export { x } from "../recovery/recovery-test-support";'],
    ["dynamic import", 'const m = await import("../recovery/recovery-test-support");'],
    ["require", 'const m = require("../recovery/recovery-test-support");'],
    ["multiline import", 'import {\n  x,\n  y,\n} from "../recovery/recovery-test-support";'],
    ["directory target", 'import { x } from "../recovery";'],
  ])("rejects %s", (_name, source) => {
    const problems = check(ROLES, source);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("another integration area");
  });

  it("rejects another feature's integration directory", () => {
    const file = "apps/api/src/auth/integration/a.integration.test.ts";
    const source = 'import { x } from "../../documents/integration/upload-support";';
    expect(check(file, source)).toHaveLength(1);
  });

  it("treats integration/<area> and <feature>/integration as different areas", () => {
    const source = 'import { x } from "../../provisioning/integration/test-harness";';
    expect(check(ROLES, source)).toHaveLength(1);
  });

  it("keeps the shared helper allowed once it lives in testing/", () => {
    const file = `${DB}/integration/orphans/orphan.integration.test.ts`;
    expect(check(file, 'import { x } from "../../testing/recovery-test-support";')).toEqual([]);
    expect(check(file, 'import { x } from "../recovery/recovery-test-support";')).toHaveLength(1);
  });
});

describe("structure-check command reports cross-area imports", () => {
  let dir;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "structure-imports-"));
    spawnSync("git", ["init", "-q"], { cwd: dir });
    const write = (rel, text) => {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), text);
    };
    write(`${DB}/testing/x.ts`, "export const x = 1;\n");
    write(RECOVERY, "export const y = 1;\n");
    write(
      `${DB}/integration/orphans/b.integration.test.ts`,
      'import { y } from "../recovery/recovery-test-support";\n',
    );
    write(
      `${DB}/integration/roles/c.integration.test.ts`,
      'import { x } from "../../testing/x";\n',
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("fails naming only the offending file", () => {
    const result = spawnSync("node", [script, dir], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("orphans/b.integration.test.ts");
    expect(result.stderr).not.toContain("roles/c.integration.test.ts");
  });
});
