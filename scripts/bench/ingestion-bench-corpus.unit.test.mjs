import { describe, expect, it } from "vitest";
import { CLASSES, documentText, MIX } from "./ingestion-bench-corpus.mjs";

describe("documentText", () => {
  it("has exactly the requested length, is ASCII, and is deterministic", () => {
    const text = documentText(1, 12_345);
    expect(text).toHaveLength(12_345);
    expect(Buffer.byteLength(text)).toBe(12_345);
    expect(documentText(1, 12_345)).toBe(text);
    expect(documentText(2, 12_345)).not.toBe(text);
  });
  it("keeps the largest class at the parser's text limit and the mix within one workspace's quota", () => {
    expect(CLASSES.max).toBe(2_000_000);
    expect(Object.values(MIX).reduce((a, b) => a + b)).toBe(50);
  });
});
