import { describe, expect, it } from "vitest";
import { isTransientDbError } from "./transient-db-error";

const coded = (code: string, wrap = false) => {
  const inner = Object.assign(new Error("driver"), { code });
  return wrap ? new Error("Failed query", { cause: inner }) : inner;
};

describe("isTransientDbError", () => {
  it.each([
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "57P01",
    "57P03",
    "53300",
    "08006",
    "40001",
    "40P01",
    "57014",
    "55P03",
  ])("treats %s as transient, also under a Drizzle wrapper", (code) => {
    expect(isTransientDbError(coded(code))).toBe(true);
    expect(isTransientDbError(coded(code, true))).toBe(true);
  });

  it.each(["42501", "42P01", "23505", "22P02", "28P01"])("treats %s as permanent", (code) => {
    expect(isTransientDbError(coded(code, true))).toBe(false);
  });

  it("recognises the pg client's own connection errors, which carry no code", () => {
    expect(isTransientDbError(new Error("Connection terminated unexpectedly"))).toBe(true);
    expect(isTransientDbError(new Error("timeout exceeded when trying to connect"))).toBe(true);
  });

  it("treats everything else as permanent", () => {
    expect(isTransientDbError(new Error("boom"))).toBe(false);
    expect(isTransientDbError("ECONNRESET")).toBe(false);
    expect(isTransientDbError(undefined)).toBe(false);
  });
});
