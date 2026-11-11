import { describe, expect, it } from "vitest";
import { toSummary } from "./document-repository";

const row = (status: string | null) => ({
  id: "00000000-0000-4000-8000-000000000001",
  displayName: "notes.txt",
  mime: "text/plain",
  sizeBytes: 12,
  createdAt: new Date("2026-10-30T12:00:00Z"),
  status,
  errorCode: null,
  errorRetryable: null,
});

describe("toSummary", () => {
  it.each(["uploaded", "processed", "ready", "failed"])("accepts status %s", (status) => {
    expect(toSummary(row(status)).status).toBe(status);
  });

  it.each([null, "unknown"])("rejects status %s", (status) => {
    expect(() => toSummary(row(status))).toThrow("Unexpected document row in database");
  });
});

describe("toSummary failure", () => {
  const failed = (errorCode: string | null, errorRetryable: boolean | null) =>
    toSummary({ ...row("failed"), errorCode, errorRetryable }).error;

  it("carries a stable code and the verdict, only for a failed version", () => {
    expect(failed("parse.encrypted", false)).toEqual({ code: "parse.encrypted", retryable: false });
    expect(failed("storage.unavailable", true)).toEqual({
      code: "storage.unavailable",
      retryable: true,
    });
    expect(
      toSummary({ ...row("ready"), errorCode: "internal", errorRetryable: true }).error,
    ).toBeNull();
  });

  it.each([null, "Some free text: /etc/passwd", "x".repeat(65), "parse..bad"])(
    "reports %j as a non-retryable internal error",
    (code) => {
      expect(failed(code, true)).toEqual({ code: "internal", retryable: false });
    },
  );
});
