import { describe, expect, it } from "vitest";
import { isTimeout, settled, stats, wall } from "./retrieval-timing.mjs";

const timeoutError = () => Object.assign(new Error("canceling statement"), { code: "57014" });

/** A statement that takes `cost(call)` ms of a fake clock, or throws what `cost` returns. */
function fake(cost) {
  let clock = 0;
  let calls = 0;
  const fn = async () => {
    const step = cost(calls);
    calls += 1;
    if (step instanceof Error) throw step;
    clock += step;
  };
  return { fn, now: () => clock, calls: () => calls };
}

describe("wall", () => {
  it("times warm rounds after one warm-up call and aggregates them", async () => {
    const s = fake((n) => [10, 30, 10, 20][n] ?? 10);
    const result = await wall(s.fn, 3, s.now);
    expect(s.calls()).toBe(4);
    expect(result).toEqual({ median: 20, min: 10, max: 30, runs: [30, 10, 20] });
  });

  it("repeats a statement slower than two seconds only twice", async () => {
    const s = fake(() => 2500);
    const result = await wall(s.fn, 7, s.now);
    expect(result.runs).toEqual([2500, 2500]);
    expect(s.calls()).toBe(3);
  });

  it("records a warm-up timeout without any timed round", async () => {
    const s = fake(() => timeoutError());
    expect(await wall(s.fn, 7, s.now)).toEqual({ timeout: true, completedRuns: [] });
    expect(s.calls()).toBe(1);
  });

  it("records a timeout in a later round and keeps the finished rounds", async () => {
    const s = fake((n) => (n === 3 ? timeoutError() : 12));
    expect(await wall(s.fn, 7, s.now)).toEqual({ timeout: true, completedRuns: [12, 12] });
    expect(s.calls()).toBe(4);
  });

  it("does not turn another database error into a timeout", async () => {
    const warm = fake((n) => (n === 0 ? Object.assign(new Error("boom"), { code: "42P01" }) : 1));
    await expect(wall(warm.fn, 3, warm.now)).rejects.toThrow("boom");
    const later = fake((n) => (n === 2 ? new Error("connection lost") : 1));
    await expect(wall(later.fn, 3, later.now)).rejects.toThrow("connection lost");
  });
});

describe("settled and isTimeout", () => {
  it("returns rows, an empty timed-out result, or rethrows", async () => {
    expect(await settled(async () => [1, 2])).toEqual({ timeout: false, rows: [1, 2] });
    expect(
      await settled(async () => {
        throw timeoutError();
      }),
    ).toEqual({ timeout: true, rows: [] });
    await expect(
      settled(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(isTimeout({ code: "57014" })).toBe(true);
    expect(isTimeout({ code: "57P01" })).toBe(false);
    expect(isTimeout(undefined)).toBe(false);
  });

  it("stats takes the conventional median: the middle sample, or the mean of the middle two", () => {
    expect(stats([1, 3]).median).toBe(2);
    expect(stats([3, 1]).median).toBe(2);
    expect(stats([5.41, 3.21]).median).toBeCloseTo(4.31, 10);
    expect(stats([4, 1, 3, 2]).median).toBe(2.5);
    expect(stats([7]).median).toBe(7);
    expect(stats([9, 1, 5]).median).toBe(5);
    expect(stats([1, 2, 3, 4, 5, 6, 7]).median).toBe(4);
    expect(stats([2, 8])).toEqual({ median: 5, min: 2, max: 8, runs: [2, 8] });
  });

  it("stats sorts a copy and keeps the runs in order", () => {
    const runs = [3, 1, 2];
    expect(stats(runs)).toEqual({ median: 2, min: 1, max: 3, runs: [3, 1, 2] });
    expect(runs).toEqual([3, 1, 2]);
  });
});
