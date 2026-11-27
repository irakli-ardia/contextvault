import { describe, expect, it } from "vitest";
import { groupSession, PROPOSED_PROTOCOL } from "./ingestion-compare-blocks.mjs";
import {
  asEntry,
  FULL,
  session,
  sessionRun,
  sessionWith,
} from "./ingestion-compare-blocks-fixtures.mjs";

const codes = (list) => list.map((n) => n.code);

describe("proposed protocol", () => {
  it("is labeled unapproved and frozen", () => {
    expect(PROPOSED_PROTOCOL.approved).toBe(false);
    expect(Object.isFrozen(PROPOSED_PROTOCOL)).toBe(true);
    expect(PROPOSED_PROTOCOL.sequence.join("")).toBe(FULL);
  });
});

describe("supported session lengths", () => {
  it.each([12, 16, 20])("accepts %i runs in the proposed order", (n) => {
    const result = groupSession(session(FULL.slice(0, n)));
    expect(result.failures).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.status).toBe("valid");
    expect(result.blocks).toHaveLength(n / 4);
    expect(result.blocks.every((b) => b.complete && b.orientationOk)).toBe(true);
  });

  it("assigns slots, blocks and positions and keeps every run", () => {
    const { runs, blocks } = groupSession(session(FULL.slice(0, 8)));
    expect(runs.map((r) => [r.slot, r.block, r.position, r.label])).toEqual(
      "ABBABAAB".split("").map((l, i) => [i + 1, (i >> 2) + 1, (i % 4) + 1, l]),
    );
    expect(blocks.map((b) => [b.expected, b.actual])).toEqual([
      ["ABBA", "ABBA"],
      ["BAAB", "BAAB"],
    ]);
  });
});

describe("incomplete and invalid sessions", () => {
  it.each([
    [4, 8],
    [8, 4],
    [13, 3],
    [17, 3],
  ])("reports %i in-order runs as incomplete, not valid", (n, missing) => {
    const result = groupSession(session(FULL.slice(0, n)));
    expect(result.status).toBe("incomplete");
    expect(codes(result.incomplete)).toEqual(["incomplete-session"]);
    expect(result.missingRuns).toBe(missing);
  });

  it("marks a partial last block", () => {
    const { blocks } = groupSession(session(FULL.slice(0, 13)));
    expect(blocks.at(-1)).toMatchObject({
      block: 4,
      actual: "B",
      complete: false,
      orientationOk: true,
    });
  });

  it("is incomplete, never valid, for an empty or missing input", () => {
    expect(groupSession([]).status).toBe("incomplete");
    expect(groupSession(undefined).runs).toEqual([]);
  });

  it("rejects the wrong arm order", () => {
    const result = groupSession(session("BAABABBAABBA"));
    expect(result.status).toBe("invalid");
    expect(codes(result.failures)).toContain("arm-sequence");
    expect(result.blocks[0]).toMatchObject({
      expected: "ABBA",
      actual: "BAAB",
      orientationOk: false,
    });
  });

  it("shows a hole that breaks the arm order as invalid and a short tail as incomplete", () => {
    const entries = session(FULL.slice(0, 12));
    const hole = groupSession(entries.filter((_, i) => i !== 1));
    expect(hole.status).toBe("invalid");
    expect(codes(hole.failures)).toContain("arm-sequence");
    expect(groupSession(entries.slice(0, 11)).status).toBe("incomplete");
  });

  it("rejects a run beyond the maximum of 20", () => {
    const result = groupSession(session(`${FULL}B`));
    expect(result.status).toBe("invalid");
    expect(codes(result.failures)).toContain("unexpected-run");
    expect(result.runs).toHaveLength(21);
  });

  it("rejects an unknown arm, keeping the run in its slot", () => {
    const result = groupSession(
      sessionWith(FULL.slice(0, 12), 3, (r) => (r.schema.arm = "virtual")),
    );
    expect(codes(result.failures)).toEqual(expect.arrayContaining(["unknown-arm", "run-invalid"]));
    expect(result.runs[3]).toMatchObject({ slot: 4, label: null, valid: false });
  });
});

describe("identities", () => {
  it("reports a duplicate run id and keeps both runs", () => {
    const entries = session(FULL.slice(0, 12));
    entries[5] = asEntry(sessionRun("B", 5, { edit: (r) => (r.runId = "00000002") }), 5);
    const result = groupSession(entries);
    expect(codes(result.failures)).toContain("duplicate-run-id");
    expect(result.status).toBe("invalid");
    expect(result.runs).toHaveLength(12);
  });

  it("reports duplicate file content", () => {
    const entries = session(FULL.slice(0, 12));
    const result = groupSession([...entries, entries[0]]);
    expect(codes(result.failures)).toEqual(
      expect.arrayContaining(["duplicate-file-content", "duplicate-run-id"]),
    );
  });

  it("reports a missing run id", () => {
    const result = groupSession(sessionWith(FULL.slice(0, 12), 2, (r) => delete r.runId));
    expect(codes(result.failures)).toContain("missing-run-id");
  });
});

describe("timestamps and idle gaps", () => {
  it("orders by startedAt whatever the input order", () => {
    const entries = session(FULL.slice(0, 12));
    const result = groupSession([...entries].reverse());
    expect(result.status).toBe("valid");
    expect(result.runs.map((r) => r.label).join("")).toBe(FULL.slice(0, 12));
  });

  it("keeps an unreadable start unplaced and invalid", () => {
    const result = groupSession(sessionWith(FULL.slice(0, 12), 4, (r) => (r.startedAt = "soon")));
    expect(result.status).toBe("invalid");
    expect(codes(result.failures)).toContain("unplaced-run");
    expect(result.runs.at(-1)).toMatchObject({ slot: null, block: null });
    expect(result.runs).toHaveLength(12);
  });

  it("keeps an unreadable end in its slot as invalid", () => {
    const result = groupSession(
      sessionWith(FULL.slice(0, 12), 4, (r) => (r.completedAt = "later")),
    );
    expect(codes(result.failures)).toContain("invalid-timestamp");
    expect(result.runs[4].slot).toBe(5);
    expect(result.gaps.some((g) => g.kind === "unknown")).toBe(true);
  });

  it("treats overlapping runs as invalid", () => {
    const result = groupSession(session(FULL.slice(0, 12), { gapSeconds: -60 }));
    expect(result.status).toBe("invalid");
    expect(codes(result.failures)).toContain("overlapping-runs");
  });

  it("finds an overlap with a run that ended after the next one began", () => {
    const entries = session(FULL.slice(0, 12), { gapSeconds: 600 });
    entries[0] = asEntry(
      sessionRun("A", 0, {
        gapSeconds: 600,
        edit: (r) => (r.completedAt = sessionRun("A", 2, { gapSeconds: 600 }).startedAt),
      }),
      0,
    );
    const result = groupSession(entries);
    expect(result.gaps.filter((g) => g.kind === "overlap").map((g) => g.after)).toEqual([2]);
    expect(result.gaps[1]).toMatchObject({ after: 3, seconds: 0, kind: "short" });
  });

  it("treats equal start times as overlapping", () => {
    const entries = session(FULL.slice(0, 12));
    entries[1] = asEntry(
      sessionRun("B", 1, { edit: (r) => (r.startedAt = entries[0].identity.startedAt) }),
      1,
    );
    expect(codes(groupSession(entries).failures)).toContain("overlapping-runs");
  });

  it.each([
    [119, ["short-idle-gap"]],
    [120, []],
    [121, []],
    [1800, []],
    [1801, ["long-idle-gap"]],
  ])("an idle gap of %i s warns %j", (gapSeconds, expected) => {
    const result = groupSession(session(FULL.slice(0, 12), { gapSeconds }));
    expect(new Set(codes(result.warnings))).toEqual(new Set(expected));
    expect(result.status).toBe("valid");
    expect(result.gaps[0].seconds).toBe(gapSeconds);
  });
});
