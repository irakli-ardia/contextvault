import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repo = join(import.meta.dirname, "..", "..");
let dir;

// The api root globs are single-level on purpose (zones must not overlap, and Fallow's `*` does
// not cross `/`); a new feature directory must be assigned a zone. Runs the real .fallowrc.json
// against a throwaway api tree.
function arch(files) {
  dir = mkdtempSync(join(tmpdir(), "api-boundaries-"));
  writeFileSync(join(dir, "package.json"), '{"name":"fixture","private":true}');
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return spawnSync(
    join(repo, "node_modules/.bin/fallow"),
    ["architecture", "--boundaries", "--config", join(repo, ".fallowrc.json"), "--root", dir],
    { encoding: "utf8" },
  );
}

const a = "apps/api/src/";
const tree = (http, extra = {}) => ({
  [`${a}main.ts`]: 'import "./app";\nimport "./auth/a";\nimport "./documents/d";\n',
  [`${a}app.ts`]: 'import "./http/h";\nimport "./auth/a";\nimport "./documents/d";\n',
  [`${a}http/h.ts`]: http,
  [`${a}auth/a.ts`]: 'import "../http/h";\nexport const a = 1;\n',
  [`${a}documents/d.ts`]: 'import "../http/h";\nimport "../auth/a";\n',
  [`${a}documents/http/c.ts`]: 'import "../../http/h";\n',
  [`${a}integration/app/g.test.ts`]: 'import "../../auth/a";\nimport "../../documents/d";\n',
  [`${a}health/x.ts`]: 'import "../http/h";\n',
  [`${a}storage/s.ts`]: "export const s = 1;\n",
  [`${a}workspaces/w.ts`]: 'import "../http/h";\n',
  ...extra,
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("api zone boundaries", () => {
  it("allows features and the root -> http, and http -> its own files", () => {
    const r = arch(tree("export const h = 1;\n"));
    expect(r.stdout + r.stderr).not.toMatch(/boundary violation/i);
    expect(r.status).toBe(0);
  });

  it("keeps documents/http in the api zone, not api-http", () => {
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
});
