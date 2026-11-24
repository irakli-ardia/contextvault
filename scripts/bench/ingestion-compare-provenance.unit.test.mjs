import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { changed, LEGACY_SHA, makeRun } from "./ingestion-compare-fixtures.mjs";
import { loadDirectory } from "./ingestion-compare-load.mjs";
import { compareProvenance, normalizeProvenance } from "./ingestion-compare-provenance.mjs";

const stored = (over) => makeRun({ arm: "stored-tsv", ...over });
const dirs = [];
const write = (files) => {
  const dir = mkdtempSync(join(tmpdir(), "compare-load-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files))
    writeFileSync(join(dir, name), typeof content === "string" ? content : JSON.stringify(content));
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("directory loading", () => {
  it("loads every file, in name order, including invalid ones", () => {
    const dir = write({
      "b.json": makeRun({ index: 1, arm: "stored-tsv" }),
      "a.json": makeRun({ index: 0 }),
      "c.json": changed(makeRun({ index: 2 }), (r) => (r.status = "invalid")),
      "notes.txt": "ignored",
    });
    const { entries, errors } = loadDirectory(dir);
    expect(entries.map((e) => [e.file, e.valid])).toEqual([
      ["a.json", true],
      ["b.json", true],
      ["c.json", false],
    ]);
    expect(errors).toEqual([]);
  });

  it("reports malformed JSON and unreadable files as entries", () => {
    const dir = write({ "bad.json": "{not json", "ok.json": makeRun() });
    mkdirSync(join(dir, "folder.json"));
    const { entries } = loadDirectory(dir);
    const byFile = Object.fromEntries(entries.map((e) => [e.file, e]));
    expect(byFile["bad.json"].failures[0].code).toBe("malformed-json");
    expect(byFile["bad.json"].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(byFile["folder.json"].failures[0].code).toBe("unsupported-file-type");
    expect(byFile["ok.json"].valid).toBe(true);
  });

  it("reports a missing directory and an empty one", () => {
    expect(loadDirectory(join(tmpdir(), "compare-load-missing")).errors[0].code).toBe(
      "directory-unreadable",
    );
    expect(loadDirectory(write({})).errors[0].code).toBe("no-json-files");
  });

  it("reports duplicate run and experiment ids", () => {
    const dir = write({ "a.json": makeRun(), "b.json": makeRun() });
    expect(loadDirectory(dir).errors.map((e) => e.code)).toEqual([
      "duplicate-runId",
      "duplicate-experimentId",
    ]);
  });
});

describe("provenance", () => {
  // Compares the normalized provenance directly: a run that differs in one field would
  // otherwise be rejected earlier by its own validation, which other tests cover.
  const compare = (...runs) =>
    compareProvenance(
      runs.map((r, i) => ({ file: `r${i}.json`, provenance: normalizeProvenance(r) })),
    );

  it("allows what differs by construction", () => {
    const result = compare(makeRun({ index: 0 }), stored({ index: 1 }), makeRun({ index: 2 }));
    expect(result).toEqual({ consistent: true, reference: "r0.json", mismatches: [] });
  });

  it("allows another key order", () => {
    const reordered = changed(
      makeRun({ index: 1 }),
      (r) => (r.environment = Object.fromEntries(Object.entries(r.environment).reverse())),
    );
    expect(compare(makeRun(), reordered).consistent).toBe(true);
  });

  it.each([
    ["another commit", (r) => (r.gitSha = LEGACY_SHA), "gitSha"],
    ["another diff hash", (r) => (r.diffSha256 = "a".repeat(64)), "diffSha256"],
    [
      "another image",
      (r) => (r.containers.postgres.imageId = "sha256:other"),
      "containers.postgres",
    ],
    ["another CPU limit", (r) => (r.containers.postgres.cpuLimit = 4), "containers.postgres"],
    ["another host", (r) => (r.environment.node = "v22.0.0"), "environment.node"],
    ["another workload", (r) => (r.config.repeats = 5), "config.repeats"],
    ["another command line", (r) => r.cli.arguments.push("--smoke"), "cli.arguments"],
    ["the server-stats flag", (r) => delete r.config.serverStats, "config.serverStats"],
  ])("detects %s", (_name, edit, field) => {
    const result = compare(makeRun({ index: 0 }), changed(makeRun({ index: 1 }), edit));
    expect(result.consistent).toBe(false);
    expect(result.mismatches[0].file).toBe("r1.json");
    expect(result.mismatches[0].fields).toContain(field);
  });

  it("leaves invalid runs out of the comparison but not out of the entries", () => {
    const dir = write({
      "a.json": makeRun(),
      "b.json": changed(makeRun({ index: 1 }), (r) => (r.workingTreeDirty = true)),
    });
    const { entries, provenance } = loadDirectory(dir);
    expect(entries).toHaveLength(2);
    expect(provenance.mismatches).toEqual([]);
  });
});
