import { describe, expect, it } from "vitest";
import { redriveCooldownMs } from "./recovery-policy";

const min = 60_000;

describe("redriveCooldownMs", () => {
  it("doubles from 5 minutes and caps at 6 hours", () => {
    const seq = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((rows) => redriveCooldownMs(rows, 0));
    expect(seq).toEqual([5, 10, 20, 40, 80, 160, 320, 360, 360, 360, 360].map((m) => m * min));
  });

  it("subtracts the attempts consumed", () => {
    expect(redriveCooldownMs(3, 2)).toBe(5 * min);
    expect(redriveCooldownMs(4, 2)).toBe(10 * min);
    expect(redriveCooldownMs(5, 2)).toBe(20 * min);
  });

  it.each([
    [Number.NaN, Number.NaN],
    [Number.POSITIVE_INFINITY, 0],
    [Number.NEGATIVE_INFINITY, 0],
    [Number.MAX_VALUE, 0],
    [Number.MAX_SAFE_INTEGER, -5],
    [-3, -3],
    [2.9, 0.5],
    [undefined, undefined],
  ])("stays finite, nonnegative and bounded for (%s, %s)", (rows, attempt) => {
    const ms = redriveCooldownMs(rows, attempt);
    expect(Number.isFinite(ms)).toBe(true);
    expect(ms).toBeGreaterThanOrEqual(5 * min);
    expect(ms).toBeLessThanOrEqual(360 * min);
  });

  // count() maps NaN, +-Infinity, undefined and negatives to 0; huge finite values stay huge.
  it.each([
    [Number.NaN, 0, 5],
    [0, Number.NaN, 5],
    [Number.POSITIVE_INFINITY, 0, 5],
    [Number.NEGATIVE_INFINITY, 0, 5],
    [10, Number.POSITIVE_INFINITY, 360],
    [undefined, undefined, 5],
    [-3, -3, 5],
    [2.9, 0.5, 10],
    [Number.MAX_VALUE, 0, 360],
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 5],
    [Number.MAX_SAFE_INTEGER, 0, 360],
  ])("sanitizes (%s, %s) to exactly %i minutes", (rows, attempt, minutes) => {
    expect(redriveCooldownMs(rows, attempt)).toBe(minutes * min);
  });

  it("never shrinks as outbox rows grow nor grows as attempts grow", () => {
    for (let attempt = 0; attempt <= 6; attempt++) {
      for (let rows = 0; rows <= 14; rows++) {
        const ms = redriveCooldownMs(rows, attempt);
        expect(redriveCooldownMs(rows + 1, attempt)).toBeGreaterThanOrEqual(ms);
        expect(redriveCooldownMs(rows, attempt + 1)).toBeLessThanOrEqual(ms);
      }
    }
  });
});
