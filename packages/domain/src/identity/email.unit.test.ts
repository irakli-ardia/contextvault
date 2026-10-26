import { describe, expect, it } from "vitest";
import { DomainError } from "../kernel/errors";
import { parseEmail } from "./email";

describe("parseEmail", () => {
  it("trims and lowercases", () => {
    expect(parseEmail("  Ada.Lovelace@Example.COM ")).toBe("ada.lovelace@example.com");
  });

  it.each([
    "",
    "no-at.example.com",
    "two@@example.com",
    "a@b@example.com",
    "a@example",
    "sp ace@example.com",
    "İ@example.com",
    "ÀDA@example.com",
    `${"a".repeat(250)}@b.co`,
    "a\nb@y.co",
  ])("rejects %j", (value) => {
    expect(() => parseEmail(value)).toThrow(DomainError);
  });
});
