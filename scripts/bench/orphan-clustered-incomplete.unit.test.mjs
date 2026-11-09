import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { entryOf } from "./orphan-clustered.mjs";
import { classify, extractAccounting, TARGETS } from "./orphan-clustered-checks.mjs";
import { renderClustered } from "./orphan-report.mjs";

const load = (url) => JSON.parse(readFileSync(new URL(url, import.meta.url), "utf8"));
// The control/tail C3 plan of the smoke run: Limit -> Sort -> Nested Loop -> Bitmap Heap Scan.
const tailPlan = load("./orphan-clustered-tail-plan.fixture.json");
const pagePlan = load("../../benchmarks/orphan-discovery/plans.json")[
  "post-vacuum/A+B-no-include/worker/page-1"
];
const committed = { minMs: 1, maxMs: 2 };
const PAGE_ORACLE = { e: 703, r1: 28, q: 675, r2: 175, o: 500 };
const TAIL_ORACLE = { e: 13, r1: 0, q: 13, r2: 4, o: 9 };

function entry(config, scenario, complete, over = {}, plan = pagePlan) {
  const oracle = complete ? PAGE_ORACLE : TAIL_ORACLE;
  const summary = { executionMs: 0.5, planningMs: 1, sharedHit: 1, sharedRead: 0 };
  const base = { dataset: "control", scenario, config, complete, q: oracle.q };
  const run = { runs: [0.5], summary, plan };
  return { ...entryOf(run, base, oracle), status: "ok", ...over };
}

const page = (config, over) => entry(config, "page-1", true, over);
const tail = (over) => entry("C3", "tail", false, over, tailPlan);
const timedOut = (config) => ({
  dataset: "control",
  scenario: "page-1",
  config,
  status: "timeout",
  estimate: { totalCost: 1 },
});

describe("incomplete-page accounting", () => {
  it("fixture is the unsupported shape that made the smoke run INCONCLUSIVE", () => {
    expect(extractAccounting(tailPlan)).toEqual({
      comparable: false,
      reason: "no nested loop under the limit",
    });
  });

  it("marks it not applicable and keeps the verdict PASS", () => {
    const v = classify([page("C3"), page("C2"), tail()], committed);
    expect(v.overall).toBe("PASS");
    expect(v.V4).toEqual({
      verdict: "PASS",
      invalid: [],
      inconclusive: [],
      notApplicable: ["control/C3/tail: no nested loop under the limit"],
    });
  });

  it("stays INCONCLUSIVE for the same plan on a complete page", () => {
    const v = classify([entry("C3", "page-1", true, {}, tailPlan), page("C2")], committed);
    expect(v.overall).toBe("INCONCLUSIVE");
    expect(v.V4.inconclusive).toHaveLength(1);
    expect(v.V4.notApplicable).toEqual([]);
  });

  it("never hides a timeout, a plan failure or a mismatch behind the incomplete page", () => {
    const base = [page("C3"), page("C2")];
    expect(
      classify([...base, { ...timedOut("C3"), scenario: "tail", complete: false }], committed),
    ).toMatchObject({ overall: "FAIL", P1: { verdict: "FAIL" } });
    const spill = tail({ shape: { fail: ["sort spills disk"] } });
    expect(classify([...base, spill], committed).overall).toBe("FAIL");
    expect(classify([...base, tail({ invalid: true })], committed).overall).toBe("INVALID");
  });

  it("reports why accounting was not applicable", () => {
    const entries = [page("C3"), page("C2"), tail()];
    const dataset = { key: "control", clusters: [], counts: {}, sizeBytes: 1, problems: [] };
    dataset.scenarios = [{ key: "page-1", complete: true }];
    const environment = { image: "i", serverVersionNum: 1, port: 1, workerStatementTimeout: "15s" };
    const result = { startedAt: "a", completedAt: "b", migrations: 1, waiting: 1, page: 50 };
    Object.assign(result, { environment: { ...environment, settings: {} }, cleanup: {} });
    Object.assign(result, { entries, datasets: [dataset], targets: TARGETS });
    result.verdicts = classify(entries, committed);
    const md = renderClustered(result);
    expect(md).toContain("not applicable (incomplete page): no nested loop under the limit");
    expect(md).toContain("## Verdict: PASS");
  });
});

describe("P5 comparison pairs", () => {
  it("passes with normal pairs", () => {
    const v = classify([page("C3"), page("C2", { medianMs: 5 })], committed);
    expect(v.P5).toMatchObject({ verdict: "PASS", pairs: 1 });
    expect(v.overall).toBe("PASS");
  });

  it("is INCONCLUSIVE, never PASS, with zero pairs", () => {
    const v = classify([page("C3")], committed);
    expect(v.P5).toMatchObject({ verdict: "INCONCLUSIVE", pairs: 0 });
    expect(v.overall).toBe("INCONCLUSIVE");
  });

  it("does not pair a timed-out C2", () => {
    const v = classify([page("C3"), timedOut("C2")], committed);
    expect(v.P5.pairs).toBe(0);
    expect(v.overall).toBe("INCONCLUSIVE");
  });

  it("lets a real FAIL or INVALID outrank it", () => {
    expect(classify([page("C3", { medianMs: 50 })], committed).overall).toBe("FAIL");
    const off = page("C2", { invalid: true });
    expect(classify([page("C3"), off], committed).overall).toBe("INVALID");
  });
});
