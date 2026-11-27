// What the recorded evidence cannot show, and the fail-closed handling of malformed loader entries.
// A test named "indistinguishable" documents an evidence limit; it is not missing-run detection.

import { describe, expect, it } from "vitest";
import { groupSession } from "./ingestion-compare-blocks.mjs";
import { FULL, session } from "./ingestion-compare-blocks-fixtures.mjs";

const codes = (list) => list.map((n) => n.code);
const LABELS = FULL.slice(0, 12);

describe("evidence limits (not detection)", () => {
  it("accepts runs 1-11 and 14 of a 20-run session: runs 12 and 13 are invisible", () => {
    const all = session(FULL, { gapSeconds: 120 });
    const kept = [...all.slice(0, 11), all[13]];
    const result = groupSession(kept);
    expect(result.runCount).toBe(12);
    expect(result.status).toBe("valid");
    expect(result.failures).toEqual([]);
    expect(result.missingRuns).toBe(0);
    // The only trace is the idle time before the 12th observed run, inside the proposed limits.
    expect(result.gaps.at(-1).seconds).toBe(2 * (540 + 120) + 120);
    expect(result.warnings).toEqual([]);
  });

  it("cannot tell the first 12 runs of an intended 16-run session from a complete 12-run one", () => {
    const first12 = groupSession(session(FULL.slice(0, 16)).slice(0, 12));
    expect(first12.status).toBe("valid");
    expect(first12).toMatchObject({ runCount: 12, missingRuns: 0, failures: [] });
  });

  it("defines missingRuns as the distance to the next supported length only", () => {
    expect(groupSession(session(FULL.slice(0, 13))).missingRuns).toBe(3);
    expect(groupSession(session(FULL.slice(0, 20))).missingRuns).toBe(0);
  });
});

describe("malformed loader entries fail closed", () => {
  const withEntry = (slot, patch) =>
    session(LABELS).map((e, i) => (i === slot ? { ...e, ...patch } : e));

  it.each([
    ["missing", undefined],
    ["null", null],
    ["unknown", { standing: "bogus", reasons: [] }],
    ["a string instead of an object", "valid"],
    ["an object without standing", {}],
    ["a non-string standing", { standing: 1 }],
    ["an object as standing", { standing: { standing: "valid" } }],
  ])("rejects a loader-valid run whose standing is %s", (_, standing) => {
    const result = groupSession(withEntry(3, { standing }));
    expect(result.status).toBe("invalid");
    expect(codes(result.failures)).toEqual(["run-invalid"]);
    expect(result.runs[3]).toMatchObject({ slot: 4, valid: true });
    expect(result.runs[3].standing).toEqual(standing ?? null);
  });

  it("accepts only valid === true", () => {
    const result = groupSession(withEntry(3, { valid: "true" }));
    expect(result.status).toBe("invalid");
    expect(result.runs[3].valid).toBe(false);
  });

  it("records valid:true without provenance as a failure, never a throw", () => {
    const entries = withEntry(3, { provenance: undefined });
    const result = groupSession(entries);
    expect(result.status).toBe("invalid");
    expect(codes(result.failures)).toEqual(["malformed-provenance"]);
    expect(result.runs).toHaveLength(12);
  });

  it.each([null, "x", 3, []])("records provenance %j as malformed", (provenance) => {
    expect(codes(groupSession(withEntry(5, { provenance })).failures)).toEqual([
      "malformed-provenance",
    ]);
  });

  it("records provenance that cannot be canonicalized, such as a 40-level nesting", () => {
    let deep = {};
    for (let i = 0; i < 40; i++) deep = { deep };
    const result = groupSession(withEntry(5, { provenance: deep }));
    expect(codes(result.failures)).toEqual(["malformed-provenance"]);
  });

  it("uses the next usable run as the provenance reference when the first is malformed", () => {
    const result = groupSession(withEntry(0, { provenance: null }));
    expect(result.provenance.reference).toBe(result.runs[1].file);
    expect(result.provenance.consistent).toBe(true);
  });

  it("does not mutate hostile entries and stays deterministic", () => {
    const entries = withEntry(2, { standing: { standing: {} }, provenance: [] });
    const before = structuredClone(entries);
    const first = groupSession(entries);
    expect(entries).toEqual(before);
    expect(groupSession([...entries].reverse())).toEqual(first);
  });
});
