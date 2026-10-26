import { describe, expect, it } from "vitest";
import { DomainError } from "../kernel/errors";
import { parsePassword } from "./password";

describe("parsePassword", () => {
  it("accepts the length bounds, counted in characters after NFKC", () => {
    expect(parsePassword("a".repeat(12))).toHaveLength(12);
    expect(parsePassword("a".repeat(128))).toHaveLength(128);
    // U+FB01 (fi ligature) normalizes to two characters: 6 of them are 12 after NFKC.
    expect(parsePassword("ﬁ".repeat(6))).toBe("fi".repeat(6));
    expect(parsePassword("😀".repeat(12))).toBe("😀".repeat(12));
  });

  it.each(["", "a".repeat(11), "a".repeat(129), "a".repeat(100_000)])(
    "rejects length %#",
    (value) => {
      expect(() => parsePassword(value)).toThrow(DomainError);
    },
  );

  it("never puts the password in the error", () => {
    const secret = "correct horse";
    try {
      parsePassword(secret.slice(0, 5));
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain(secret.slice(0, 5));
    }
  });
});
