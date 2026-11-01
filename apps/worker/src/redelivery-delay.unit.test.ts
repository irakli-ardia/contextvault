import { describe, expect, it } from "vitest";
import { redeliveryDelayMs } from "./redelivery-delay";

const top = () => 0.999999;
const bottom = () => 0;

describe("redeliveryDelayMs", () => {
  it.each([
    [1, 5_000],
    [2, 10_000],
    [3, 20_000],
    [4, 40_000],
    [5, 60_000],
    [6, 60_000],
  ])("delivery %i waits at most %i ms and at least half", (n, ceiling) => {
    expect(redeliveryDelayMs(5_000, n, top)).toBeLessThanOrEqual(ceiling);
    expect(redeliveryDelayMs(5_000, n, top)).toBeGreaterThan(ceiling - 2);
    expect(redeliveryDelayMs(5_000, n, bottom)).toBe(ceiling / 2);
  });

  it.each([0, undefined, -3, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "treats counter %s as the first delivery",
    (n) => {
      expect(redeliveryDelayMs(5_000, n, top)).toBeLessThanOrEqual(5_000);
      expect(redeliveryDelayMs(5_000, n, bottom)).toBe(2_500);
    },
  );

  it("stays at the cap for huge counters", () => {
    for (const n of [1_000, 2 ** 31, Number.MAX_SAFE_INTEGER]) {
      expect(redeliveryDelayMs(5_000, n, top)).toBeLessThanOrEqual(60_000);
      expect(redeliveryDelayMs(5_000, n, bottom)).toBe(30_000);
    }
  });

  it("scales short test delays and never exceeds the cap for a large base", () => {
    expect(redeliveryDelayMs(100, 3, top)).toBeLessThanOrEqual(400);
    expect(redeliveryDelayMs(100, 1, bottom)).toBe(50);
    expect(redeliveryDelayMs(120_000, 1, top)).toBeLessThanOrEqual(60_000);
  });

  it.each([Number.NaN, -1, 2, Number.POSITIVE_INFINITY])("clamps random() = %s", (r) => {
    const delay = redeliveryDelayMs(5_000, 2, () => r);
    expect(delay).toBeGreaterThanOrEqual(5_000);
    expect(delay).toBeLessThanOrEqual(10_000);
  });

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])("treats base %s as no delay", (base) => {
    expect(redeliveryDelayMs(base, 3, top)).toBe(0);
  });
});
