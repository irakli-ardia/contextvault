import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { changed } from "./ingestion-compare-fixtures.mjs";
import { loadDirectory, loadFile, loadText } from "./ingestion-compare-load.mjs";
import { standingOf } from "./ingestion-compare-outcomes.mjs";
import { codesOf, retry, runOf, scenarioWith } from "./ingestion-compare-outcomes-fixtures.mjs";

const load = (run) => loadText("a.json", JSON.stringify(run));
const codes = (run) => codesOf(load(run).standing);

describe("a valid run through the loader", () => {
  it("adds a valid standing and keeps every existing field", () => {
    const run = runOf();
    const entry = load(run);
    expect(entry).toMatchObject({
      valid: true,
      failures: [],
      standing: { standing: "valid", reasons: [] },
    });
    expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.provenance).toBeDefined();
    expect(entry.metrics).toHaveLength(4);
  });

  it("leaves loader validity and metrics as before when the standing is invalid", () => {
    const run = runOf([scenarioWith((s) => s.jobLog.push(retry())), ...runOf().scenarios.slice(1)]);
    const entry = load(run);
    expect(entry.valid).toBe(true);
    expect(entry.standing.standing).toBe("invalid");
    expect(entry.metrics[0].reliability.jobEvents.retry).toBe(1);
  });

  it("does not mutate the parsed result", () => {
    const run = runOf([scenarioWith((s) => s.jobLog.push(retry()))]);
    const before = structuredClone(run);
    standingOf({ failures: [], result: run });
    expect(run).toEqual(before);
  });
});

describe("run-level evidence", () => {
  it.each([
    [
      "an interrupted benchmark",
      { status: "interrupted", interruptedDuring: "burst" },
      "run-interrupted",
    ],
    ["a failed benchmark execution", { status: "failed", failedDuring: "setup" }, "run-failed"],
    ["an invalid run", { status: "invalid" }, "run-invalid"],
    ["an unfinished run", { status: "started" }, "run-incomplete"],
  ])("is invalid for %s", (_, patch, code) => {
    const entry = load({ ...runOf(), ...patch });
    expect(entry.valid).toBe(false);
    expect(entry.standing.standing).toBe("invalid");
    expect(codesOf(entry.standing)).toContain(code);
  });

  it("is invalid when cleanup failed or was never verified", () => {
    expect(codes(changed(runOf(), (r) => (r.cleanup = { verified: false, error: "x" })))).toContain(
      "cleanup-unverified",
    );
    expect(codes(changed(runOf(), (r) => delete r.cleanup))).toContain("cleanup-unverified");
  });

  it("is invalid for a schema that was not verified, was unknown or is missing", () => {
    expect(codes(changed(runOf(), (r) => (r.schema.verified = false)))).toContain(
      "schema-unverified",
    );
    expect(codes(changed(runOf(), (r) => (r.schema.arm = "bogus")))).toContain("loader-failure");
    expect(codes(changed(runOf(), (r) => delete r.schema))).toContain("schema-unverified");
  });

  it("is invalid with no scenarios", () => {
    expect(codes(changed(runOf(), (r) => (r.scenarios = [])))).toContain("scenarios-missing");
  });

  it("keeps coexisting reasons from different layers", () => {
    const run = changed(runOf(), (r) => {
      r.cleanup.verified = false;
      r.status = "interrupted";
      r.scenarios[0].statementErrors = [{ label: "chunks", code: "57014" }];
    });
    expect(codes(run)).toEqual(
      expect.arrayContaining([
        "cleanup-unverified",
        "run-interrupted",
        "statement-cancelled-unattributed",
        "loader-failure",
      ]),
    );
  });

  it("never turns a loader-invalid entry into a valid one", () => {
    const run = changed(runOf(), (r) => (r.gitSha = "nope"));
    const entry = load(run);
    expect(entry.valid).toBe(false);
    expect(entry.standing.standing).toBe("invalid");
  });
});

describe("unreadable and malformed input", () => {
  it.each([
    ["malformed JSON", "{"],
    ["a JSON array", "[]"],
    ["null", "null"],
    ["a string", '"x"'],
  ])("is invalid for %s", (_, text) => {
    const entry = loadText("a.json", text);
    expect(entry.valid).toBe(false);
    expect(entry.standing.standing).toBe("invalid");
  });

  it("is invalid for an unreadable file", () => {
    const entry = loadFile("/x/a.json", undefined, () => {
      throw Object.assign(new Error("x"), { code: "ENOENT" });
    });
    expect(entry.standing.standing).toBe("invalid");
  });

  it("is total over hostile values and never reads inherited or coerced data", () => {
    const hostile = [
      undefined,
      null,
      {},
      { failures: "x", result: 1 },
      {
        failures: [],
        result: {
          scenarios: [
            null,
            1,
            [],
            {
              jobLog: [
                null,
                {
                  code: {
                    toString() {
                      throw new Error("no");
                    },
                  },
                },
              ],
            },
          ],
        },
      },
      JSON.parse(
        '{"failures":[],"result":{"__proto__":{"status":"complete"},"scenarios":[{"__proto__":{"jobs":1},"name":{}}]}}',
      ),
    ];
    for (const input of hostile) {
      const out = standingOf(input);
      expect(out.standing).toBe("invalid");
      expect(out.reasons.length).toBeGreaterThan(0);
    }
  });

  it("bounds untrusted text kept in a reason", () => {
    const run = runOf([
      scenarioWith(
        (s) => (s.statementErrors = [{ label: "x".repeat(500), code: "y".repeat(500) }]),
      ),
    ]);
    const detail = standingOf({ failures: [], result: run }).reasons.find((r) => r.detail)?.detail;
    expect(detail.length).toBeLessThanOrEqual(121);
  });
});

describe("committed baseline evidence", () => {
  const dir = join(import.meta.dirname, "../../benchmarks/ingestion");
  const files = readdirSync(dir).filter((n) => /^ingestion-clean-run\d\.json$/.test(n));

  it("finds the committed runs", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("classifies %s without changing its loader result", (name) => {
    const entry = loadFile(join(dir, name));
    const { standing, ...rest } = entry;
    expect(rest.sha256).toBe(loadText(name, readFileSync(join(dir, name))).sha256);
    // These runs predate schema metadata, so the loader refuses them; the standing must agree.
    expect(standing.standing).toBe(entry.valid ? "valid" : "invalid");
    expect(codesOf(standing)).not.toContain("statement-cancelled-unattributed");
    expect(standing.reasons.filter((r) => r.kind === "performance")).toEqual([]);
  });

  it.each(files)(
    "finds no scenario-level reason in %s, including the rejected oversize input",
    (name) => {
      const result = JSON.parse(readFileSync(join(dir, name), "utf8"));
      const { reasons } = standingOf({ failures: [], result });
      expect(reasons.filter((r) => r.scope !== "run")).toEqual([]);
      expect(reasons.map((r) => r.code)).toEqual(["schema-unverified"]);
    },
  );

  it("reads the committed directory exactly as before", () => {
    const set = loadDirectory(dir);
    expect(set.entries.map((e) => e.file)).toEqual(files.sort());
  });
});
