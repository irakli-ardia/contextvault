import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { STORED_TSV_DDL } from "./ingestion-bench-schema.mjs";
import { changed, LEGACY_SHA, legacyRun, makeRun } from "./ingestion-compare-fixtures.mjs";
import { loadText, validateResult } from "./ingestion-compare-load.mjs";
import { CONTROL_SCENARIOS } from "./ingestion-compare-server.mjs";

const codes = (result) => validateResult(result).failures.map((f) => f.code);
const stored = (over) => makeRun({ arm: "stored-tsv", ...over });

describe("a valid run", () => {
  it.each(["baseline", "stored-tsv"])("accepts a %s run", (arm) => {
    const entry = loadText("a.json", JSON.stringify(makeRun({ arm })));
    expect(entry.failures).toEqual([]);
    expect(entry.valid).toBe(true);
    expect(entry.identity).toMatchObject({ arm, runId: "00000000", gitSha: expect.any(String) });
  });

  it("computes the SHA-256 of the exact bytes", () => {
    const text = `${JSON.stringify(makeRun(), null, 2)}\n`;
    expect(loadText("a.json", text).sha256).toBe(createHash("sha256").update(text).digest("hex"));
  });

  it("exposes the four control values", () => {
    const { controls } = validateResult(makeRun({ embedMs: 801.5 }));
    expect(Object.keys(controls)).toEqual(CONTROL_SCENARIOS);
    expect(controls["sequential-max"]).toEqual({ embedMedianMs: 801.5, n: 10 });
  });
});

describe("run validation", () => {
  it.each([
    ["a failed run", (r) => (r.status = "invalid"), "status"],
    ["another benchmark", (r) => (r.benchmark = "keyword"), "benchmark"],
    ["failed cleanup", (r) => (r.cleanup.verified = false), "cleanup"],
    [
      "a failed scenario verification",
      (r) => (r.scenarios[3].verification.ok = false),
      "scenario-verification",
    ],
    ["a missing verification", (r) => delete r.scenarios[2].verification, "scenario-verification"],
    ["no scenarios", (r) => (r.scenarios = []), "scenarios"],
    ["a dirty tree", (r) => (r.workingTreeDirty = true), "dirty-tree"],
    ["an unknown tree state", (r) => (r.workingTreeDirty = null), "dirty-tree"],
    ["a bad commit", (r) => (r.gitSha = "abc"), "git-sha"],
    ["a bad start time", (r) => (r.startedAt = "yesterday"), "timestamp"],
    ["a bad end time", (r) => (r.completedAt = "2026-13-45"), "timestamp"],
    ["an end before the start", (r) => (r.completedAt = "2026-01-01T00:00:00.000Z"), "timestamp"],
    ["a missing run id", (r) => delete r.runId, "run-id"],
  ])("rejects %s", (_name, edit, code) => {
    expect(codes(changed(makeRun(), edit))).toContain(code);
  });

  it("keeps every reason of a run that fails twice", () => {
    const run = changed(makeRun(), (r) => {
      r.status = "invalid";
      r.cleanup.verified = false;
    });
    expect(codes(run)).toEqual(expect.arrayContaining(["status", "cleanup"]));
  });

  it("does not throw on a non-object value", () => {
    for (const value of [null, 3, "x", [], true])
      expect(loadText("a.json", JSON.stringify(value)).failures[0].code).toBe("structure");
  });
});

describe("schema arm validation", () => {
  it.each([
    ["an unknown arm", (r) => (r.schema.arm = "virtual"), "schema-arm"],
    ["an arm that differs from the command line", (r) => (r.schema.arm = "baseline"), "schema-arm"],
    ["an unverified arm", (r) => (r.schema.verified = false), "schema-verified"],
    ["a missing column", (r) => (r.schema.column = null), "schema-column"],
    ["a virtual column", (r) => (r.schema.column.generated = "v"), "schema-column"],
    ["a nullable column", (r) => (r.schema.column.notNull = false), "schema-column"],
    ["a wrong column type", (r) => (r.schema.column.type = "text"), "schema-column"],
    [
      "a wrong expression",
      (r) => (r.schema.column.expression = "to_tsvector('english'::regconfig, content)"),
      "schema-column",
    ],
    ["a wrong DDL", (r) => (r.schema.ddl = [STORED_TSV_DDL.split("\n")[0]]), "schema-ddl"],
    [
      "a virtual DDL",
      (r) => (r.schema.ddl[0] = r.schema.ddl[0].replace("STORED", "VIRTUAL")),
      "schema-ddl",
    ],
  ])("rejects stored-tsv with %s", (_name, edit, code) => {
    expect(codes(changed(stored(), edit))).toContain(code);
  });

  it("accepts the expression as the catalog prints it", () => {
    const run = changed(
      stored(),
      (r) => (r.schema.column.expression = "to_tsvector('simple'::regconfig, content)"),
    );
    expect(codes(run)).toEqual([]);
  });

  it.each([
    ["a content_tsv column", (r) => (r.schema.column = { type: "tsvector" }), "schema-column"],
    ["applied DDL", (r) => (r.schema.ddl = ["ALTER TABLE chunks"]), "schema-ddl"],
    ["a stored-tsv command line", (r) => r.cli.arguments.push("--schema=stored-tsv"), "schema-arm"],
  ])("rejects a baseline run with %s", (_name, edit, code) => {
    expect(codes(changed(makeRun(), edit))).toContain(code);
  });

  it("rejects legacy evidence with an explicit diagnostic", () => {
    const entry = loadText("old.json", JSON.stringify(legacyRun()));
    expect(entry.valid).toBe(false);
    expect(entry.failures).toContainEqual({
      code: "legacy",
      detail: expect.stringContaining("no schema metadata"),
    });
    expect(entry.identity.gitSha).toBe(LEGACY_SHA);
  });
});
