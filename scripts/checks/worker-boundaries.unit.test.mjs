import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repo = join(import.meta.dirname, "..", "..");
let dir;

// The worker root globs are single-level on purpose (zones must not overlap); do not widen them.
// Runs the real .fallowrc.json zones against a throwaway worker tree. Fallow resolves --config
// against the cwd, so the real file is passed explicitly.
function arch(files) {
  dir = mkdtempSync(join(tmpdir(), "worker-boundaries-"));
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

const w = "apps/worker/src/";
const tree = (queue, ingestion) => ({
  [`${w}main.ts`]: 'import "./queue/q";\nimport "./ingestion/i";\n',
  [`${w}queue/q.ts`]: queue,
  [`${w}ingestion/i.ts`]: ingestion,
  [`${w}error-cause.ts`]: "export const e = 1;\n",
  [`${w}testing/t.ts`]: "export const t = 1;\n",
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("worker zone boundaries", () => {
  it("allows ingestion -> queue and both -> worker root and testing", () => {
    const r = arch(
      tree(
        'import "../error-cause";\nimport "../testing/t";\nexport const q = 1;\n',
        'import "../queue/q";\nimport "../error-cause";\nimport "../testing/t";\n',
      ),
    );
    expect(r.stdout + r.stderr).not.toMatch(/boundary violation/i);
    expect(r.status).toBe(0);
  });

  it("rejects queue -> ingestion", () => {
    const r = arch(tree('import "../ingestion/i";\n', "export const i = 1;\n"));
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("worker-queue → worker-ingestion");
  });

  it("fails coverage for a worker directory assigned to no zone", () => {
    const r = arch({
      ...tree("export const q = 1;\n", "export const i = 1;\n"),
      [`${w}jobs/j.ts`]: "export const j = 1;\n",
    });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("no matching boundary zone");
  });
});
