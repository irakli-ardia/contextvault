import { describe, expect, it } from "vitest";
import { DomainError } from "./errors";
import { parseUserId, parseWorkspaceId } from "./ids";

const valid = "0b1c9d3e-5a7f-4c2d-8e1f-3a4b5c6d7e8f";

describe("id parsing", () => {
  it.each(["", "not-a-uuid", `${valid}x`, valid.toUpperCase(), `'; drop table users; --`])(
    "rejects %j",
    (value) => {
      expect(() => parseUserId(value)).toThrow(DomainError);
      expect(() => parseWorkspaceId(value)).toThrow(DomainError);
    },
  );

  it("accepts a canonical lowercase uuid", () => {
    expect(parseUserId(valid)).toBe(valid);
    expect(parseWorkspaceId(valid)).toBe(valid);
  });
});
