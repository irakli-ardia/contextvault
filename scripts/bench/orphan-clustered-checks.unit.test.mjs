import { describe, expect, it } from "vitest";
import {
  checkPage,
  classify,
  compareCounts,
  extractAccounting,
  grade,
  isNoisy,
  planShape,
  reconcile,
  windowProblems,
} from "./orphan-clustered-checks.mjs";

// Hand-built EXPLAIN (ANALYZE, FORMAT JSON) reports; only the fields the extractor reads.
const outerScan = (over = {}) => ({
  "Node Type": "Index Scan",
  "Relation Name": "document_versions",
  "Actual Loops": 1,
  "Actual Rows": 700,
  Filter: "(attempt < 3)",
  "Rows Removed by Filter": 40,
  ...over,
});
const lateral = (over = {}) => ({
  "Node Type": "Aggregate",
  "Actual Loops": 700,
  Plans: [{ "Node Type": "Index Only Scan", "Relation Name": "outbox", "Actual Loops": 700 }],
  ...over,
});
const report = ({ outer = {}, inner = {}, nl = {}, limit = 500 } = {}) => ({
  Plan: {
    "Node Type": "Limit",
    "Actual Rows": limit,
    Plans: [
      {
        "Node Type": "Nested Loop",
        "Actual Rows": limit,
        "Join Filter": "(NOT COALESCE(h.has_live, false))",
        "Rows Removed by Join Filter": 200,
        Plans: [outerScan(outer), lateral(inner)],
        ...nl,
      },
    ],
  },
});
const ORACLE = { e: 740, r1: 40, q: 700, r2: 200, o: 500 };

describe("extractAccounting", () => {
  it("reads E, R1, Q, R2 and O from the supported shape", () => {
    expect(extractAccounting(report())).toEqual({ comparable: true, ...ORACLE });
  });

  it.each([
    ["parallel plan", report({ outer: { "Parallel Aware": true } })],
    ["memoize node", report({ inner: { Plans: [{ "Node Type": "Memoize" }] } })],
    ["outer path is Sort", report({ outer: { "Node Type": "Sort" } })],
    ["outer path is Seq Scan", report({ outer: { "Node Type": "Seq Scan" } })],
    ["outer scan looped", report({ outer: { "Actual Loops": 3 } })],
    ["not the attempt filter", report({ outer: { Filter: "(status = 'queued')" } })],
    ["not the attempt filter", report({ outer: { Filter: undefined } })],
    ["differ from outer rows", report({ inner: { "Actual Loops": 699 } })],
  ])("reports %s as not comparable instead of guessing", (reason, plan) => {
    const acc = extractAccounting(plan);
    expect(acc.comparable).toBe(false);
    expect(acc.reason).toContain(reason);
  });

  it("derives R2 from Q minus the nested loop's rows, not from any filter counter", () => {
    const plan = report({ nl: { "Join Filter": undefined, "Rows Removed by Join Filter": 999 } });
    expect(extractAccounting(plan)).toEqual({ comparable: true, ...ORACLE });
  });

  it("rejects a plan without a nested loop under the limit", () => {
    const plan = { Plan: { "Node Type": "Limit", Plans: [{ "Node Type": "Hash Join" }] } };
    expect(extractAccounting(plan).reason).toMatch(/no nested loop/);
  });
});

describe("reconcile", () => {
  const acc = extractAccounting(report());
  it("accepts an exact match", () => expect(reconcile(acc, ORACLE)).toEqual([]));
  it("names every mismatching quantity", () => {
    expect(reconcile(acc, { ...ORACLE, q: 701, r2: 201 })).toEqual([
      "q: plan 700 != oracle 701",
      "r2: plan 200 != oracle 201",
    ]);
  });
  it("checks the plan's own invariants", () => {
    expect(reconcile({ ...acc, o: 499 }, { ...ORACLE, o: 499 })).toEqual(["plan: q != r2 + o"]);
  });
  it("skips plans that are not comparable", () => {
    expect(reconcile({ comparable: false, reason: "x" }, ORACLE)).toEqual([]);
  });
});

describe("planShape", () => {
  it("accepts the expected shape without review", () => {
    expect(planShape(report())).toEqual({ fail: [], review: null });
  });
  it("fails a seq scan on outbox, a disk sort and a gather without merge", () => {
    const bad = report({
      inner: { Plans: [{ "Node Type": "Seq Scan", "Relation Name": "outbox" }] },
      outer: { "Sort Space Type": "Disk", "Node Type": "Gather" },
    });
    expect(planShape(bad).fail).toEqual([
      "seq scan on outbox",
      "sort spills to disk",
      "gather without merge",
    ]);
  });
  it("flags an alternative shape for review instead of failing it", () => {
    const shape = planShape(report({ outer: { "Node Type": "Sort" } }));
    expect(shape.fail).toEqual([]);
    expect(shape.review).toMatch(/outer path/);
  });
});

describe("checkPage", () => {
  const rows = (n) => Array.from({ length: n }, (_, k) => ({ versionId: `v${k}` }));
  const ranks = (n, from) => new Map(Array.from({ length: n }, (_, k) => [`v${k}`, from + k]));
  const base = { afterRank: 9, limit: 3, complete: true, windows: [], oracle: { o: 3 } };
  const page = (n, from, over = {}) => ({ ...base, rows: rows(n), ranks: ranks(n, from), ...over });

  it("accepts a complete page", () => expect(checkPage(page(3, 10))).toEqual([]));
  it("rejects a short complete page and a full incomplete page", () => {
    expect(checkPage(page(2, 10, { oracle: { o: 2 } }))).toEqual(["complete page has 2 rows"]);
    expect(checkPage(page(3, 10, { complete: false }))).toEqual(["incomplete page is full"]);
  });
  it("accepts a short page only when the scenario is incomplete", () => {
    expect(checkPage(page(2, 10, { complete: false, oracle: { o: 2 } }))).toEqual([]);
  });
  it("rejects rows at or before the cursor and rows inside a window", () => {
    expect(checkPage(page(3, 9))).toContain("rows not ascending after the cursor");
    const inside = page(3, 10, { windows: [{ lo: 11, hi: 12 }] });
    expect(checkPage(inside)).toContain("row inside a cluster window");
  });
  it("rejects a page the oracle disagrees with", () => {
    expect(checkPage(page(3, 10, { oracle: { o: 4 } }))).toEqual(["source returned 3, oracle 4"]);
  });
});

describe("dataset checks", () => {
  const win = { e: 20, r1: 0, q: 20, live: 20, cooling: 0, deleted: 0 };
  it("validates cluster windows by kind", () => {
    expect(windowProblems(win, { lo: 0, hi: 20, kind: "live" })).toEqual([]);
    expect(windowProblems(win, { lo: 0, hi: 20, kind: "cooldown" })).toEqual([
      "live row in cooldown window",
    ]);
    expect(windowProblems(win, { lo: 0, hi: 20, kind: "mixed" })).toEqual([
      "mixed window is not mixed",
    ]);
    expect(windowProblems({ ...win, e: 19 }, { lo: 0, hi: 20, kind: "live" })[0]).toMatch(
      /holds 19/,
    );
    const dirty = { ...win, deleted: 1, r1: 1 };
    expect(windowProblems(dirty, { lo: 0, hi: 20, kind: "live" })).toEqual([
      "exhausted or deleted row in window",
    ]);
  });
  it("lists count differences between expected and database", () => {
    expect(compareCounts({ a: 1, b: 2 }, { a: 1, b: 3 })).toEqual(["b: expected 2, database 3"]);
  });
});

describe("grade and noise", () => {
  it("passes at the limit, is NEAR up to 20% over and fails beyond", () => {
    expect([grade(10, 10), grade(12, 10), grade(12.01, 10)]).toEqual(["PASS", "NEAR", "FAIL"]);
  });
  it("calls a run noisy only when max/min > 1.5 and the spread exceeds 2 ms", () => {
    expect(isNoisy([1, 2, 1.2])).toBe(false);
    expect(isNoisy([10, 16, 11])).toBe(true);
    expect(isNoisy([10, 15, 11])).toBe(false);
  });
});

describe("classify", () => {
  const e = (config, dataset, scenario, medianMs, over = {}) => ({
    config,
    dataset,
    scenario,
    status: "ok",
    complete: true,
    medianMs,
    q: 1000,
    shape: { fail: [] },
    ...over,
  });
  const ok = [
    e("C3", "control", "page-1", 2),
    e("C3", "control", "mid-50", 2),
    e("C3", "live", "D-entry", 6),
    e("C2", "control", "page-1", 2),
    e("C2", "live", "D-entry", 6),
  ];
  const committed = { minMs: 2.2, maxMs: 2.3 };
  const withRun = (extra) => classify([...ok, extra], committed);

  it("passes P1-P5 when every target is met", () => {
    const v = classify(ok, committed);
    expect(["P1", "P2", "P3", "P4", "P5"].map((k) => v[k].verdict)).toEqual(Array(5).fill("PASS"));
    expect(v.overall).toBe("PASS");
  });
  it("fails P1 on a C3 timeout but not on C0/C1 timeouts", () => {
    expect(withRun(e("C0", "control", "page-1", 0, { status: "timeout" })).P1.verdict).toBe("PASS");
    expect(withRun(e("C1", "live", "D-entry", 0, { status: "timeout" })).overall).toBe("PASS");
    expect(withRun(e("C3", "wide", "W-entry", 0, { status: "timeout" })).overall).toBe("FAIL");
  });
  it("applies the 10 ms head budget to the control and 1.5 s elsewhere", () => {
    expect(withRun(e("C3", "control", "page-1", 11)).P3.verdict).toBe("NEAR");
    expect(withRun(e("C3", "control", "mid-50", 12.5)).P3.verdict).toBe("FAIL");
    expect(withRun(e("C3", "live", "F-exit", 1500)).P3.verdict).toBe("PASS");
    expect(withRun(e("C3", "live", "F-exit", 1700)).P3.verdict).toBe("NEAR");
    expect(withRun(e("C3", "live", "F-exit", 1801)).P3.verdict).toBe("FAIL");
  });
  it("grades microseconds per qualified candidate against 3x the control median", () => {
    expect(withRun(e("C3", "live", "F-exit", 6)).P4.verdict).toBe("PASS");
    expect(withRun(e("C3", "live", "F-exit", 7)).P4.verdict).toBe("NEAR");
    expect(withRun(e("C3", "live", "F-exit", 8)).P4.verdict).toBe("FAIL");
  });
  it("ignores incomplete pages except for P1", () => {
    const v = withRun(e("C3", "control", "tail", 9999, { complete: false }));
    expect([v.P1.verdict, v.P3.verdict, v.P4.verdict]).toEqual(["PASS", "PASS", "PASS"]);
  });
  it("compares C3 with C2 by median ratio and by a single big regression", () => {
    const slow = classify(
      [...ok, e("C3", "live", "D-exit", 30), e("C2", "live", "D-exit", 15)],
      committed,
    );
    expect(slow.P5.verdict).toBe("FAIL");
    const noisyOne = classify(
      [...ok, e("C3", "live", "D-exit", 4), e("C2", "live", "D-exit", 2.5)],
      committed,
    );
    expect(noisyOne.P5.verdict).toBe("PASS");
  });
  it("marks the whole run invalid when any entry failed reconciliation", () => {
    expect(withRun(e("C3", "live", "F-exit", 6, { invalid: true })).overall).toBe("INVALID");
  });
  it("fails P2 on a hard plan problem and lists review shapes without failing", () => {
    const hard = e("C3", "live", "F-exit", 6, { shape: { fail: ["seq scan on outbox"] } });
    expect(withRun(hard).P2.verdict).toBe("FAIL");
    const alt = e("C3", "live", "F-exit", 6, { shape: { fail: [], review: "outer path is Sort" } });
    expect(withRun(alt).P2.verdict).toBe("PASS");
    expect(withRun(alt).P2.review).toEqual(["live/F-exit: outer path is Sort"]);
  });
});
