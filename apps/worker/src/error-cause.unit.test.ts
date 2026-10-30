import { describe, expect, it } from "vitest";
import { errorCause } from "./error-cause";

describe("errorCause", () => {
  it("labels an error by class and the driver code on it or a nested cause", () => {
    expect(errorCause(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toBe(
      "Error:ECONNREFUSED",
    );
    const inner = Object.assign(new Error("password=secret"), { code: "28P01" });
    expect(errorCause(new TypeError("q", { cause: inner }))).toBe("TypeError:28P01");
    expect(errorCause(new TypeError("select 1", { cause: new Error("no code") }))).toBe(
      "TypeError",
    );
  });

  it("keeps dotted domain codes within the length limit and rejects unsafe shapes", () => {
    const code = (value: string) => errorCause(Object.assign(new Error("m"), { code: value }));
    expect(code("transaction.outcome_unknown")).toBe("Error:transaction.outcome_unknown");
    expect(code(`a.${"b".repeat(38)}`)).toBe(`Error:a.${"b".repeat(38)}`);
    for (const unsafe of [
      "a".repeat(41),
      ".a",
      "a.",
      "a..b",
      "a b",
      "a\nb",
      "a\tb.c",
      "http://h.example",
      "a.b/c",
      "select * from t",
      "pw=secret.x",
      "",
    ]) {
      expect(code(unsafe)).toBe("Error");
    }
  });

  it("never returns message text, and falls back for non-errors or unsafe labels", () => {
    const leaky = Object.assign(new Error("postgres://u:pw@host/db"), { code: "a b://c" });
    expect(errorCause(leaky)).toBe("Error");
    expect(errorCause("postgres://u:pw@host")).toBe("UnknownError");
    expect(errorCause(null)).toBe("UnknownError");
  });
});
