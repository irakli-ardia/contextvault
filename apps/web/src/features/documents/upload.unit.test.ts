import { MAX_UPLOAD_BYTES } from "@contextvault/contracts";
import { describe, expect, it } from "vitest";
import { checkUpload, failureOf } from "./upload";

describe("checkUpload", () => {
  it.each([
    ["a.pdf", "application/pdf"],
    ["A.MD", "text/markdown"],
    ["a.markdown", "text/markdown"],
    ["a.txt", "text/plain"],
  ])("accepts %s", (name, contentType) => {
    expect(checkUpload({ name, size: 10 })).toEqual({ ok: true, contentType });
  });

  it.each([
    [{ name: "a.pdf", size: 0 }, "upload.empty"],
    [{ name: "a.pdf", size: MAX_UPLOAD_BYTES + 1 }, "upload.too_large"],
    [{ name: `${"x".repeat(256)}.pdf`, size: 1 }, "upload.invalid_name"],
    [{ name: "a.csv", size: 1 }, "upload.unsupported_type"],
    [{ name: "noextension", size: 1 }, "upload.unsupported_type"],
  ])("refuses %j", (file, code) => {
    expect(checkUpload(file)).toEqual({ ok: false, code });
  });

  it("accepts exactly the maximum size", () => {
    expect(checkUpload({ name: "a.pdf", size: MAX_UPLOAD_BYTES }).ok).toBe(true);
  });
});

describe("failureOf", () => {
  it("reads the API code, request id and Retry-After", () => {
    const error = failureOf(429, '{"error":{"code":"retry.throttled","requestId":"r1"}}', "12");
    expect([error.status, error.code, error.requestId, error.retryAfterSeconds]).toEqual([
      429,
      "retry.throttled",
      "r1",
      12,
    ]);
  });

  it("treats a non-JSON or malformed body as off-contract", () => {
    expect(failureOf(502, "<html>", null).code).toBe("response.invalid");
    expect(failureOf(500, "{}", "abc").retryAfterSeconds).toBeNull();
  });
});

describe("checkUpload names", () => {
  it("refuses a name with a lone surrogate", () => {
    expect(checkUpload({ name: "\ud800.pdf", size: 1 })).toEqual({
      ok: false,
      code: "upload.invalid_name",
    });
  });
});
