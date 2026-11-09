import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { entryOf } from "./orphan-clustered.mjs";
import { classify, committedRange, TARGETS } from "./orphan-clustered-checks.mjs";
import { renderClustered } from "./orphan-report.mjs";

const load = (name) =>
  JSON.parse(readFileSync(new URL(`../../benchmarks/orphan-discovery/${name}`, import.meta.url)));
const plan = load("plans.json")["post-vacuum/A+B-no-include/worker/page-1"];
const committed = committedRange(load("results.json"));
const ORACLE = { e: 703, r1: 28, q: 675, r2: 175, o: 500, live: 100, cooling: 75, deleted: 0 };

// Built by the real entryOf, as measureEntry does, from a committed EXPLAIN.
function entry(config, over = {}, oracle = ORACLE, report = plan) {
  const summary = { executionMs: 2, planningMs: 1, sharedHit: 1, sharedRead: 0 };
  const base = { dataset: "control", scenario: "page-1", config, complete: true, q: oracle.q };
  return {
    ...entryOf({ runs: [2, 2, 2], summary, plan: report }, base, oracle),
    status: "ok",
    ...over,
  };
}

function render(entries) {
  const verdicts = classify(entries, committed);
  const dataset = { key: "control", clusters: [], counts: {}, sizeBytes: 1, problems: [] };
  dataset.scenarios = [{ key: "page-1", complete: true }];
  const env = { image: "i", serverVersionNum: 180000, port: 1, workerStatementTimeout: "15s" };
  const result = { startedAt: "a", completedAt: "b", migrations: 1, waiting: 5000, page: 50 };
  Object.assign(result, { environment: { ...env, settings: {} }, targets: TARGETS, cleanup: {} });
  Object.assign(result, { entries, datasets: [dataset], verdicts });
  return { verdicts, md: renderClustered(result) };
}

const unsupported = () => {
  const p = structuredClone(plan);
  p.Plan.Plans[0].Plans[0]["Actual Loops"] = 2;
  return p;
};

describe("entryOf and renderClustered", () => {
  it("carries the oracle and renders a valid, supported run as PASS", () => {
    const c3 = entry("C3");
    expect(c3.oracle).toEqual(ORACLE);
    const { verdicts, md } = render([c3, entry("C2")]);
    expect(verdicts.overall).toBe("PASS");
    expect(md).toContain("## Verdict: PASS");
    expect(md).toContain("| control/page-1 | 703/28/675/175/500 | 703/28/675/175/500 | - |");
  });

  it("renders a proven mismatch as INVALID with no graded criteria", () => {
    const off = { ...ORACLE, r2: 176, o: 499 };
    const { verdicts, md } = render([entry("C3", {}, off), entry("C2")]);
    expect(verdicts.overall).toBe("INVALID");
    expect(verdicts.V4.invalid).toEqual(["control/C3/page-1"]);
    expect(md).toContain("## Verdict: INVALID");
    expect(md).toContain("| P3 | not graded (run INVALID) |");
    expect(md).toContain("| V4 | INVALID |");
    expect(md).not.toContain("## Verdict: PASS");
  });

  it("renders an unreconcilable C3 plan as INCONCLUSIVE, never PASS", () => {
    const { verdicts, md } = render([entry("C3", {}, ORACLE, unsupported()), entry("C2")]);
    expect(verdicts.overall).toBe("INCONCLUSIVE");
    expect(verdicts.V4.inconclusive).toEqual(["control/C3/page-1: outer scan looped"]);
    expect(md).toContain("## Verdict: INCONCLUSIVE");
    expect(md).toContain("| V4 | INCONCLUSIVE |");
    expect(md).toContain("not comparable: outer scan looped");
  });

  it("keeps a real timing FAIL over INCONCLUSIVE and INVALID over both", () => {
    const slow = entry("C3", { medianMs: 50 }, ORACLE, unsupported());
    expect(render([slow]).verdicts.overall).toBe("FAIL");
    const off = entry("C2", {}, { ...ORACLE, q: 600 });
    expect(render([slow, off]).verdicts.overall).toBe("INVALID");
  });
});
