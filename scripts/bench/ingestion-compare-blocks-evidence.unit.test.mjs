import { describe, expect, it } from "vitest";
import { groupSession } from "./ingestion-compare-blocks.mjs";
import { FULL, session, sessionWith } from "./ingestion-compare-blocks-fixtures.mjs";
import { retry } from "./ingestion-compare-outcomes-fixtures.mjs";

const LABELS = FULL.slice(0, 12);
const codes = (list) => list.map((n) => n.code);

describe("provenance", () => {
  it("reports a configuration mismatch without dropping the run", () => {
    const result = groupSession(sessionWith(LABELS, 7, (r) => (r.config.discardedWarmups = 2)));
    expect(codes(result.failures)).toContain("provenance-mismatch");
    expect(result.provenance.mismatches[0].fields).toContain("config.discardedWarmups");
    expect(result.runs).toHaveLength(12);
  });

  it("reports a container identity mismatch", () => {
    const image = `sha256:${"a".repeat(64)}`;
    const result = groupSession(
      sessionWith(LABELS, 5, (r) => (r.containers.postgres.imageId = image)),
    );
    expect(result.provenance.mismatches[0].fields).toContain("containers.postgres");
    expect(result.status).toBe("invalid");
  });

  it("does not let the two arms differ in provenance by themselves", () => {
    expect(groupSession(session(LABELS)).provenance).toMatchObject({ consistent: true });
  });
});

describe("loader and outcome standing stay visible", () => {
  it("keeps a failed run in its slot with its failures and checksum", () => {
    const entries = sessionWith(LABELS, 4, (r) => (r.status = "invalid"));
    const result = groupSession(entries);
    expect(result.status).toBe("invalid");
    expect(result.runs[4]).toMatchObject({
      slot: 5,
      block: 2,
      position: 1,
      valid: false,
      sha256: entries[4].sha256,
    });
    expect(result.runs[4].failures.map((f) => f.code)).toContain("status");
    expect(result.runs[4].standing.standing).toBe("invalid");
  });

  it("rejects failed cleanup", () => {
    const result = groupSession(sessionWith(LABELS, 0, (r) => (r.cleanup.verified = false)));
    expect(result.status).toBe("invalid");
    expect(result.runs[0].failures.map((f) => f.code)).toContain("cleanup");
  });

  it("rejects an invalid schema arm", () => {
    const result = groupSession(sessionWith(LABELS, 1, (r) => (r.schema.verified = false)));
    expect(result.status).toBe("invalid");
    expect(result.runs[1].failures.map((f) => f.code)).toContain("schema-verified");
  });

  it("does not let a loader-valid run with an invalid standing pass", () => {
    const entries = sessionWith(LABELS, 3, (r) => r.scenarios[0].jobLog.push(retry()));
    expect(entries[3]).toMatchObject({ valid: true });
    const result = groupSession(entries);
    expect(result.status).toBe("invalid");
    expect(result.runs[3]).toMatchObject({ valid: true, slot: 4 });
    expect(result.runs[3].standing.standing).toBe("invalid");
    expect(codes(result.failures)).toEqual(["run-invalid"]);
  });

  it("reports an unparseable file as unplaced and keeps its failure reason", () => {
    const bad = {
      file: "x.json",
      sha256: "f".repeat(64),
      valid: false,
      failures: [{ code: "malformed-json" }],
      identity: null,
    };
    const result = groupSession([...session(LABELS), bad]);
    expect(result.status).toBe("invalid");
    expect(result.runs.at(-1)).toMatchObject({ file: "x.json", slot: null, valid: false });
    expect(result.runs.at(-1).failures[0].code).toBe("malformed-json");
  });
});

describe("determinism and purity", () => {
  it("gives the same result for any input order", () => {
    const entries = sessionWith(LABELS, 6, (r) => (r.cleanup.verified = false));
    const expected = groupSession(entries);
    expect(groupSession([...entries].reverse())).toEqual(expected);
    expect(groupSession([...entries.slice(5), ...entries.slice(0, 5)])).toEqual(expected);
  });

  it("does not mutate its input", () => {
    const entries = session(LABELS);
    const before = structuredClone(entries);
    groupSession(entries);
    expect(entries).toEqual(before);
  });

  it("is total over hostile entries", () => {
    const result = groupSession([null, 3, "x", [], { identity: 5, valid: "yes" }, {}]);
    expect(result.status).toBe("invalid");
    expect(result.runs).toHaveLength(6);
  });
});
