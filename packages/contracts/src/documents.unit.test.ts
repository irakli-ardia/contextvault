import { describe, expect, it } from "vitest";
import { parseDocumentListResponse, parseDocumentResponse } from "./documents";

const ok = {
  id: "3b1c9d3e-5a7f-4c2d-8e1f-3a4b5c6d7e8f",
  displayName: "a.txt",
  mime: "text/plain",
  sizeBytes: 3,
  status: "failed",
  error: { code: "parse.encrypted", retryable: false },
  createdAt: "2026-11-11T10:00:00.000Z",
};

describe("document response contract", () => {
  it("accepts a document with and without an error", () => {
    expect(parseDocumentResponse(ok)).toEqual(ok);
    expect(parseDocumentResponse({ ...ok, status: "ready", error: null })?.error).toBeNull();
  });

  it.each([
    ["an extra field", { ...ok, storageKey: "ws/x" }],
    ["a missing field", { ...ok, error: undefined }],
    ["an unknown status", { ...ok, status: "deleted" }],
    ["an unknown mime", { ...ok, mime: "text/html" }],
    ["a bad date", { ...ok, createdAt: "yesterday" }],
    ["a negative size", { ...ok, sizeBytes: -1 }],
    ["an error with an extra field", { ...ok, error: { ...ok.error, detail: "x" } }],
    ["an error without a verdict", { ...ok, error: { code: "internal" } }],
    ["null", null],
  ])("rejects %s", (_name, value) => {
    expect(parseDocumentResponse(value)).toBeNull();
  });

  it("validates every list item and nothing else", () => {
    expect(parseDocumentListResponse({ documents: [ok, ok] })?.documents).toHaveLength(2);
    expect(parseDocumentListResponse({ documents: [] })?.documents).toEqual([]);
    expect(parseDocumentListResponse({ documents: [ok, { ...ok, id: 1 }] })).toBeNull();
    expect(parseDocumentListResponse({ documents: [], next: "x" })).toBeNull();
    expect(parseDocumentListResponse([ok])).toBeNull();
  });
});
