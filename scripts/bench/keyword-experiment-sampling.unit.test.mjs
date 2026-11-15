import { describe, expect, it } from "vitest";
import { clocked, nearestToMedian, sample, sampleSummary } from "./keyword-experiment-sampling.mjs";

const timeout = () => Object.assign(new Error("canceling statement"), { code: "57014" });
/** A statement whose successive calls take `steps` ms; a step of "timeout" throws SQLSTATE 57014. */
const script = (steps) => {
  let call = 0;
  return async () => {
    const step = steps[call];
    call += 1;
    if (step === "timeout") throw timeout();
    if (step === "fault") throw new Error("syntax error");
    return { ms: step, value: `plan-${call}` };
  };
};

describe("sample", () => {
  it("never counts the warm-up and uses the conventional median", async () => {
    const result = await sample(script([999, 4, 1, 2, 3]), { runs: 4 });
    expect(result.warmup).toEqual({ ms: 999 });
    expect(result.samples).toEqual([4, 1, 2, 3]);
    expect(result.median).toBe(2.5); // mean of the two middle samples, not the upper one
    expect(result).toMatchObject({ requested: 4, collected: 4, stop: "complete", min: 1, max: 4 });
  });

  it("keeps the samples taken before a timeout and says it stopped early", async () => {
    const result = await sample(script([5, 10, 20, "timeout", 30]), { runs: 5 });
    expect(result.samples).toEqual([10, 20]);
    expect(result).toMatchObject({ requested: 5, collected: 2, stop: "timeout", median: 15 });
  });

  it("reports a warm-up timeout with no samples and no fabricated statistics", async () => {
    const result = await sample(script(["timeout", 1]), { runs: 5 });
    expect(result).toMatchObject({
      collected: 0,
      stop: "warmup-timeout",
      warmup: { timeout: true },
    });
    expect(result.median).toBeUndefined();
  });

  it("bounds the time spent on a slow statement and never claims the requested count", async () => {
    const result = await sample(script([14000, 14000, 14000, 14000, 14000, 14000]), {
      runs: 5,
      budgetMs: 30_000,
    });
    expect(result.collected).toBe(3); // 14 s + 14 s < 30 s, so a third runs; then 42 s spent
    expect(result.stop).toBe("budget");
    expect(result.requested).toBe(5);
  });

  it("does not hide a real fault as a slow sample", async () => {
    await expect(sample(script([1, 2, "fault"]), { runs: 3 })).rejects.toThrow(/syntax/);
    await expect(sample(script(["fault"]), { runs: 3 })).rejects.toThrow(/syntax/);
  });

  it("selects the value of the sample nearest the median and strips raw values from the summary", async () => {
    const result = await sample(script([0, 1, 100, 2]), { runs: 3 });
    expect(nearestToMedian(result)).toBe("plan-4"); // 2 ms is the median
    expect(sampleSummary(result)).not.toHaveProperty("values");
  });
});

describe("clocked", () => {
  it("returns the elapsed time of the statement", async () => {
    const times = [10, 35];
    const run = clocked(
      async () => {},
      () => times.shift(),
    );
    expect(await run()).toEqual({ ms: 25 });
  });
});
