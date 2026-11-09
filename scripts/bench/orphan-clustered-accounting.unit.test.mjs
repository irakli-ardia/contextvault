import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classify, extractAccounting, reconcile } from "./orphan-clustered-checks.mjs";

// Real worker A+B-no-include plans committed with the original benchmark: Limit -> Nested Loop ->
// Index Scan (versions) + Subquery Scan -> Aggregate -> Index Scan (outbox).
const committedPlans = JSON.parse(
  readFileSync(new URL("../../benchmarks/orphan-discovery/plans.json", import.meta.url), "utf8"),
);
const real = (phase, depth) => committedPlans[`${phase}-vacuum/A+B-no-include/worker/${depth}`];

describe("extractAccounting on committed plans", () => {
  const expected = {
    "page-1": [703, 28, 675, 175, 500],
    "depth-50": [703, 28, 675, 175, 500],
    "depth-90": [703, 28, 675, 175, 500],
    "depth-99": [704, 28, 676, 176, 500],
  };
  it.each(["pre", "post"].flatMap((phase) => Object.keys(expected).map((depth) => [phase, depth])))(
    "%s-vacuum %s is comparable and consistent",
    (phase, depth) => {
      const [e, r1, q, r2, o] = expected[depth];
      const acc = extractAccounting(real(phase, depth));
      expect(acc).toEqual({ comparable: true, e, r1, q, r2, o });
      expect(reconcile(acc, { e, r1, q, r2, o })).toEqual([]);
    },
  );

  it("does not guess when the lateral wrapper is altered", () => {
    const plan = structuredClone(real("post", "depth-50"));
    const sub = plan.Plan.Plans[0].Plans[1];
    sub["Actual Loops"] = 674;
    expect(extractAccounting(plan).reason).toMatch(/subquery loops differ/);
    sub["Actual Loops"] = 675;
    sub.Plans.push({ "Node Type": "Result" });
    expect(extractAccounting(plan).reason).toMatch(/no lateral aggregate/);
  });
});

describe("classify medians", () => {
  it("takes the mean of the two middle values for an even-length median", () => {
    const e = (ms) => ({
      config: "C3",
      dataset: "control",
      scenario: `s${ms}`,
      status: "ok",
      complete: true,
      medianMs: ms,
      q: 1000,
      shape: { fail: [] },
    });
    const v = classify([e(2), e(4), e(6), e(10)], { minMs: 2, maxMs: 4 });
    expect(v.P6.c3ControlMs).toBe(5);
    expect(v.P6.c3ControlVsCommitted).toEqual({ low: 1.25, high: 2.5 });
  });
});
