import { describe, expect, it } from "vitest";
import { HttpError } from "../../lib/http-client";
import { searchErrorMessage } from "./messages";

describe("searchErrorMessage", () => {
  it("explains throttling with the Retry-After wait", () => {
    expect(searchErrorMessage(new HttpError(429, "search.throttled", null, 12))).toContain("12 s");
    expect(searchErrorMessage(new HttpError(429, "search.throttled"))).toContain("a moment");
    expect(searchErrorMessage(new HttpError(429, "search.throttled", null, 0))).not.toContain(
      "0 s",
    );
  });

  it("maps session, access, validation and availability failures", () => {
    expect(searchErrorMessage(new HttpError(401, "auth.unauthenticated"))).toContain(
      "session ended",
    );
    expect(searchErrorMessage(new HttpError(404, "workspace.not_found"))).toContain("access");
    expect(searchErrorMessage(new HttpError(403, "permission.denied"))).toContain("access");
    expect(searchErrorMessage(new HttpError(400, "request.invalid"))).toContain("1000");
    expect(searchErrorMessage(new HttpError(503, "embedding.unavailable"))).toContain("embedding");
    expect(searchErrorMessage(new HttpError(0, "network.unavailable"))).toContain("connection");
  });

  it("never shows a raw code", () => {
    expect(searchErrorMessage(new HttpError(500, "boom.internal"))).toBe(
      "Something went wrong. Try again.",
    );
    expect(searchErrorMessage(new Error("x"))).toBe("Something went wrong. Try again.");
  });
});
