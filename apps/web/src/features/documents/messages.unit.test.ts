import { describe, expect, it } from "vitest";
import { HttpError } from "../../lib/http-client";
import { guidanceFor, guidanceForError, isSessionEnded } from "./messages";

describe("guidance", () => {
  it("maps a known code and falls back for an unknown one", () => {
    expect(guidanceFor("parse.encrypted")).toContain("password");
    expect(guidanceFor("something.new")).toBe("Something went wrong. Try again in a moment.");
  });

  it("explains a refused role, a wait time and a foreign error", () => {
    expect(guidanceForError(new HttpError(403, "permission.denied"))).toContain("role");
    expect(guidanceForError(new HttpError(429, "retry.throttled", null, 7))).toContain(
      "Retry in 7s",
    );
    expect(guidanceForError(new Error("x"))).toBe(guidanceFor("unknown"));
  });

  it("recognises an ended session by status", () => {
    expect(isSessionEnded(new HttpError(401, "auth.unauthenticated"))).toBe(true);
    expect(isSessionEnded(new HttpError(500, "x"))).toBe(false);
  });
});
