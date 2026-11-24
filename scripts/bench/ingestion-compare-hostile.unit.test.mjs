import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { changed, makeRun } from "./ingestion-compare-fixtures.mjs";
import { loadDirectory, loadText, validateResult } from "./ingestion-compare-load.mjs";

const codes = (result) => validateResult(result).failures.map((f) => f.code);
const dirs = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "compare-hostile-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("hostile structure and type confusion", () => {
  const nested = (depth) => `${'{"a":'.repeat(depth)}1${"}".repeat(depth)}`;
  const deepText = (run, depth) =>
    JSON.stringify(changed(run, (r) => (r.environment.settings = "__DEEP__"))).replace(
      '"__DEEP__"',
      nested(depth),
    );

  it("loadDirectory keeps every entry and hash when one file nests too deeply", () => {
    const dir = tmp();
    const deep = deepText(makeRun({ index: 0 }), 5000);
    const fine = JSON.stringify(makeRun({ index: 1 }));
    writeFileSync(join(dir, "a-deep.json"), deep);
    writeFileSync(join(dir, "b-fine.json"), fine);
    const sha = (text) => createHash("sha256").update(text).digest("hex");

    const { entries, provenance } = loadDirectory(dir);

    expect(entries.map((e) => [e.file, e.valid, e.sha256])).toEqual([
      ["a-deep.json", false, sha(deep)],
      ["b-fine.json", true, sha(fine)],
    ]);
    expect(entries[0].failures.map((f) => f.code)).toEqual(["structure"]);
    expect(provenance.consistent).toBe(true);
  });

  it("accepts nesting at the depth real results use", () => {
    expect(loadText("a.json", deepText(makeRun(), 10)).valid).toBe(true);
  });

  it.each([
    ["gitSha", (r) => (r.gitSha = [r.gitSha]), "git-sha"],
    ["diffSha256", (r) => (r.diffSha256 = [r.diffSha256]), "diff-hash"],
    [
      "postgres imageId",
      (r) => (r.containers.postgres.imageId = [r.containers.postgres.imageId]),
      "container",
    ],
    [
      "redis imageId",
      (r) => (r.containers.redis.imageId = [r.containers.redis.imageId]),
      "container",
    ],
    ["gitSha object", (r) => (r.gitSha = { toString: () => r.gitSha }), "git-sha"],
  ])("rejects a one-element array or object for %s", (_name, edit, code) => {
    expect(codes(changed(makeRun(), edit))).toContain(code);
  });

  it("does not throw on values whose toString is not a function", () => {
    const hostile = { toString: 1 };
    const run = changed(makeRun(), (r) => {
      r.benchmark = hostile;
      r.status = hostile;
      r.schema.arm = hostile;
      r.scenarios[0].verification.ok = false;
      r.scenarios[0].name = hostile;
    });
    const entry = loadText("a.json", JSON.stringify(run));
    expect(entry.failures.map((f) => f.code)).not.toContain("structure");
    expect(entry.valid).toBe(false);
  });
});
