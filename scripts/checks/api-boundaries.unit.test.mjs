import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repo = join(import.meta.dirname, "..", "..");
let dir;

// The api root globs are single-level on purpose (zones must not overlap, and Fallow's `*` does
// not cross `/`); a new feature directory must be assigned a zone. Runs the real .fallowrc.json
// against a throwaway api tree.
function arch(files, reverseZones = false) {
  dir = mkdtempSync(join(tmpdir(), "api-boundaries-"));
  writeFileSync(join(dir, "package.json"), '{"name":"fixture","private":true}');
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  let config = join(repo, ".fallowrc.json");
  if (reverseZones) {
    const json = JSON.parse(readFileSync(config, "utf8"));
    json.boundaries.zones.reverse();
    json.boundaries.rules.reverse();
    config = join(dir, "reversed.fallowrc.json");
    writeFileSync(config, JSON.stringify(json));
  }
  return spawnSync(
    join(repo, "node_modules/.bin/fallow"),
    ["architecture", "--boundaries", "--config", config, "--root", dir],
    { encoding: "utf8" },
  );
}

const a = "apps/api/src/";
const tree = (http, extra = {}) => ({
  [`${a}main.ts`]: 'import "./app";\nimport "./auth/a";\nimport "./documents/d";\n',
  [`${a}app.ts`]: 'import "./http/h";\nimport "./auth/a";\nimport "./documents/d";\n',
  [`${a}http/h.ts`]: http,
  [`${a}auth/a.ts`]: 'import "../http/h";\nexport const a = 1;\n',
  [`${a}documents/d.ts`]: 'import "../http/h";\nimport "../auth/a";\nimport "../storage/s";\n',
  [`${a}documents/http/c.ts`]: 'import "../../http/h";\n',
  [`${a}integration/app/g.test.ts`]: 'import "../../auth/a";\nimport "../../documents/d";\n',
  [`${a}health/x.ts`]: 'import "../auth/a";\n',
  [`${a}storage/s.ts`]: "export const s = 1;\n",
  [`${a}workspaces/w.ts`]: 'import "../auth/a";\n',
  [`${a}testing/t.ts`]: 'import "../app";\n',
  [`${a}auth/integration/i.test.ts`]: 'import "../../testing/t";\n',
  [`${a}documents/integration/i.test.ts`]: 'import "../../testing/t";\nimport "../../storage/s";\n',
  [`${a}health/integration/i.test.ts`]: 'import "../../testing/t";\n',
  ...extra,
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("api zone boundaries", () => {
  it("allows features and the root -> http, and http -> its own files", () => {
    const r = arch(tree("export const h = 1;\n"));
    expect(r.stdout + r.stderr).not.toMatch(/boundary violation/i);
    expect(r.status).toBe(0);
  });

  it("keeps documents/http in api-documents, not api-http", () => {
    const r = arch(
      tree("export const h = 1;\n", { [`${a}documents/http/c.ts`]: 'import "../../auth/a";\n' }),
    );
    expect(r.stdout + r.stderr).not.toMatch(/boundary violation/i);
    expect(r.status).toBe(0);
  });

  it("rejects http -> documents", () => {
    const r = arch(tree('import "../documents/d";\n'));
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("api-http → api");
  });

  it("rejects http -> auth", () => {
    const r = arch(tree('import "../auth/a";\n'));
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("api-http → api");
  });

  it("fails coverage for an api directory assigned to no zone", () => {
    const r = arch(tree("export const h = 1;\n", { [`${a}jobs/j.ts`]: "export const j = 1;\n" }));
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("no matching boundary zone");
  });

  // Each case adds one forbidden edge to an otherwise valid tree; the expected text is "from → to".
  const bypasses = [
    ["auth -> documents", "auth/a.ts", 'import "../documents/d";\n', "api-auth → api-documents"],
    ["auth -> storage", "auth/a.ts", 'import "../storage/s";\n', "api-auth → api-storage"],
    ["auth -> health", "auth/a.ts", 'import "../health/x";\n', "api-auth → api-health"],
    ["auth -> workspaces", "auth/a.ts", 'import "../workspaces/w";\n', "api-auth → api-workspaces"],
    ["auth -> root", "auth/a.ts", 'import "../app";\n', "api-auth → api"],
    [
      "documents -> health",
      "documents/d.ts",
      'import "../health/x";\n',
      "api-documents → api-health",
    ],
    [
      "documents -> workspaces",
      "documents/d.ts",
      'import "../workspaces/w";\n',
      "api-documents → api-workspaces",
    ],
    ["storage -> auth", "storage/s.ts", 'import "../auth/a";\n', "api-storage → api-auth"],
    [
      "storage -> documents",
      "storage/s.ts",
      'import "../documents/d";\n',
      "api-storage → api-documents",
    ],
    ["storage -> testing", "storage/s.ts", 'import "../testing/t";\n', "api-storage → api-testing"],
    [
      "health -> documents",
      "health/x.ts",
      'import "../documents/d";\n',
      "api-health → api-documents",
    ],
    [
      "workspaces -> documents",
      "workspaces/w.ts",
      'import "../documents/d";\n',
      "api-workspaces → api-documents",
    ],
    [
      "workspaces -> testing",
      "workspaces/w.ts",
      'import "../testing/t";\n',
      "api-workspaces → api-testing",
    ],
    ["http -> testing", "http/h.ts", 'import "../testing/t";\n', "api-http → api-testing"],
    [
      "testing -> feature",
      "testing/t.ts",
      'import "../documents/d";\n',
      "api-testing → api-documents",
    ],
    // Bypass attempts: the zone is decided by the resolved target, not by import spelling.
    [
      "type-only",
      "auth/a.ts",
      'import type { D } from "../documents/d";\nexport type T = D;\n',
      "api-auth → api-documents",
    ],
    ["re-export", "auth/a.ts", 'export * from "../documents/d";\n', "api-auth → api-documents"],
    [
      "dynamic import",
      "auth/a.ts",
      'export const l = () => import("../documents/d");\n',
      "api-auth → api-documents",
    ],
    ["detour path", "auth/a.ts", 'import "../auth/../documents/d";\n', "api-auth → api-documents"],
    ["extension", "auth/a.ts", 'import "../documents/d.ts";\n', "api-auth → api-documents"],
    [
      "nested auth dir",
      "auth/integration/i.test.ts",
      'import "../../documents/d";\n',
      "api-auth → api-documents",
    ],
  ];

  for (const reverse of [false, true]) {
    for (const [name, file, text, expected] of bypasses) {
      it(`rejects ${name}${reverse ? " (zones declared in reverse order)" : ""}`, () => {
        const r = arch(tree("export const h = 1;\n", { [`${a}${file}`]: text }), reverse);
        expect(r.status).not.toBe(0);
        expect(r.stdout).toContain(expected);
      });
    }
  }

  it("allows the drawn edges in either declaration order", () => {
    for (const reverse of [false, true]) {
      const r = arch(tree("export const h = 1;\n"), reverse);
      expect(r.stdout + r.stderr).not.toMatch(/boundary violation/i);
      expect(r.status).toBe(0);
    }
  });

  it("rejects http re-exporting documents, even when auth only imports http", () => {
    const r = arch(
      tree('export * from "../documents/d";\n', {
        [`${a}auth/a.ts`]: 'export * from "../http/h";\n',
      }),
    );
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("api-http → api-documents");
  });

  it("fails coverage for unmatched directories at any depth, in either order", () => {
    for (const reverse of [false, true]) {
      for (const file of ["jobs/j.ts", "newfeature/integration/j.test.ts", "j-root/deep/er/j.ts"]) {
        const r = arch(
          tree("export const h = 1;\n", { [`${a}${file}`]: "export const j = 1;\n" }),
          reverse,
        );
        expect(r.status).not.toBe(0);
        expect(r.stdout).toContain("no matching boundary zone");
      }
    }
  });
});
