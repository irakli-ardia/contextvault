import { describe, expect, it } from "vitest";
import { changed, fullScenario } from "./ingestion-compare-fixtures.mjs";
import { scenarioMetrics } from "./ingestion-compare-metrics.mjs";

const edit = (fn, name) => scenarioMetrics(changed(fullScenario(name), fn));

describe("numeric safety", () => {
  it("keeps zero as a measurement", () => {
    const m = edit((s) => {
      s.db.counters.xact_rollback = 0;
      s.summary.max.lockClientMs.min = 0;
    });
    expect(m.db.counters.xact_rollback).toBe(0);
    expect(m.timings.max.lockClientMs.min).toBe(0);
  });

  it("turns missing numeric properties into null", () => {
    const m = edit((s) => {
      delete s.wallMs;
      delete s.db.walBytes;
      delete s.summary.max.embedMs.p95;
    });
    expect([m.wallMs, m.db.walBytes, m.timings.max.embedMs.p95]).toEqual([null, null, null]);
    expect(m.timings.max.embedMs.median).toBe(103);
  });

  const hostile = [
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["numeric string", "12"],
    ["array", [12]],
    ["object", { valueOf: 12 }],
    ["boolean", true],
    ["null", null],
  ];
  it.each(hostile)("rejects %s as a number", (_name, bad) => {
    const m = edit((s) => {
      s.wallMs = bad;
      s.jobs = bad;
      s.summary.max.activationTxMs.median = bad;
      s.db.walBytes = bad;
    });
    expect([m.wallMs, m.jobs, m.timings.max.activationTxMs.median, m.db.walBytes]).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  it("never calls a method of the input", () => {
    const trap = () => {
      throw new Error("executed");
    };
    const evil = { toString: trap, valueOf: trap, toJSON: trap };
    const m = edit((s) => {
      s.name = evil;
      s.wallMs = evil;
      s.statementErrors = [{ label: evil, code: evil }];
      s.load.saturated = [evil, "event-loop"];
    });
    expect(m.name).toBeNull();
    expect(m.load.saturated).toEqual(["event-loop"]);
    expect(m.reliability.statementErrors.byCode).toEqual({ "?:?": 1 });
  });

  it("finds the largest attempt in a very large array without a RangeError", () => {
    const m = edit((s) => {
      s.verification.statuses = Array.from({ length: 300_000 }, (_, i) => ({ attempt: i % 7 }));
    });
    expect(m.reliability.maxAttempt).toBe(6);
  });

  it("keeps a zero attempt and ignores non-numeric ones", () => {
    const zero = edit((s) => (s.verification.statuses = [{ attempt: 0 }, { attempt: "9" }]));
    expect(zero.reliability.maxAttempt).toBe(0);
    const none = edit((s) => (s.verification.statuses = [{ attempt: true }, null, {}]));
    expect(none.reliability.maxAttempt).toBeNull();
  });

  it("survives malformed or missing nested structures", () => {
    const shapes = [undefined, null, 5, "x", [], { summary: 5, db: [], load: "x", jobLog: {} }];
    for (const shape of shapes) {
      const m = scenarioMetrics(shape);
      expect(m.name).toBeNull();
      expect(m.timings).toBeNull();
      expect(m.db).toBeNull();
      expect(m.server).toBeNull();
    }
    const odd = edit((s) => {
      s.summary = { max: [], small: { embedMs: "x" } };
      s.sizesAfter = [];
      s.verification = { statuses: "x" };
    });
    expect(odd.timings.small.embedMs.median).toBeNull();
    expect(odd.reliability.maxAttempt).toBeNull();
    expect(odd.db.sizesAfter.chunks).toEqual({ heap: null, indexes: null, toastAndMaps: null });
  });
});
