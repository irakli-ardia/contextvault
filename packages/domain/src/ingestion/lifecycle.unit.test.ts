import { describe, expect, it } from "vitest";
import { isVersionStatus, versionStatuses } from "../documents/document";
import { canTransition, decideFailure, isRunning, maxAttempts } from "./lifecycle";

describe("retry policy", () => {
  it("retries after 5 s then 10 s and gives up on the third failure", () => {
    expect(decideFailure(1, true)).toEqual({ action: "retry", delayMs: 5_000 });
    expect(decideFailure(2, true)).toEqual({ action: "retry", delayMs: 10_000 });
    expect(decideFailure(maxAttempts, true)).toEqual({ action: "fail" });
    expect(decideFailure(maxAttempts + 1, true)).toEqual({ action: "fail" });
  });

  it("never retries a non-retryable failure or an unclaimed version", () => {
    expect(decideFailure(1, false)).toEqual({ action: "fail" });
    expect(decideFailure(0, true)).toEqual({ action: "fail" });
  });
});

describe("lifecycle", () => {
  it.each([
    ["uploaded", "queued"],
    ["uploaded", "parsing"],
    ["queued", "parsing"],
    ["parsing", "chunking"],
    ["parsing", "queued"],
    ["chunking", "queued"],
    ["chunking", "processed"],
    ["chunking", "failed"],
  ] as const)("allows %s -> %s", (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it.each([
    ["queued", "uploaded"],
    ["uploaded", "chunking"],
    ["queued", "chunking"],
    ["failed", "queued"],
    ["ready", "queued"],
    ["parsing", "processed"],
    ["queued", "processed"],
    ["processed", "queued"],
    ["processed", "ready"],
    ["processed", "failed"],
  ] as const)("refuses %s -> %s", (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });

  it("treats only parsing and chunking as running", () => {
    expect(versionStatuses.filter(isRunning)).toEqual(["parsing", "chunking"]);
  });
});

describe("processed", () => {
  it("is a stored status and terminal", () => {
    expect(isVersionStatus("processed")).toBe(true);
    expect(isRunning("processed")).toBe(false);
    expect(versionStatuses.filter((to) => canTransition("processed", to))).toEqual([]);
  });
});
