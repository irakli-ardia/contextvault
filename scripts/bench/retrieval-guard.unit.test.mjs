import { describe, expect, it } from "vitest";
import { assertStackEnv, assertStackIdentity } from "./retrieval-guard.mjs";

const ok = {
  verified: "1",
  marker: "m-1",
  appUrl: "postgresql://app:pw@127.0.0.1:55433/cv_test",
  fixtureUrl: "postgresql://fixture:pw2@localhost:55433/cv_test",
};
const bad = (patch) => () => assertStackEnv({ ...ok, ...patch });

describe("assertStackEnv", () => {
  it("accepts the verified isolated stack (loopback spellings share one endpoint)", () => {
    expect(bad({})).not.toThrow();
  });

  it.each([
    [{ verified: undefined }, /with-test-stack/],
    [{ verified: "true" }, /with-test-stack/],
    [{ marker: "" }, /CV_TEST_DB_MARKER/],
    [{ appUrl: "postgresql://a:b@db.internal:55433/cv_test" }, /DATABASE_URL is not a loopback/],
    [{ fixtureUrl: "postgresql://a:b@127.0.0.1:5432/cv_test" }, /non-development port/],
    [{ fixtureUrl: "postgresql://a:b@127.0.0.1/cv_test" }, /non-development port/],
    [{ appUrl: "postgresql://a:b@127.0.0.1:55433" }, /needs a database name/],
    [{ appUrl: "not a url" }, /DATABASE_URL is malformed/],
    [{ fixtureUrl: "postgresql://a:b@127.0.0.1:55434/cv_test" }, /one database/],
    [{ fixtureUrl: "postgresql://a:b@127.0.0.1:55433/other" }, /one database/],
  ])("rejects %j", (patch, message) => {
    expect(bad(patch)).toThrow(message);
  });

  it("never puts a URL or credential in an error", () => {
    for (const patch of [
      { appUrl: "postgresql://u:secretpw@db.internal:55433/x" },
      { appUrl: "%%" },
    ]) {
      try {
        assertStackEnv({ ...ok, ...patch });
      } catch (error) {
        expect(error.message).not.toMatch(/secretpw|db\.internal|postgresql:/);
      }
    }
  });
});

describe("assertStackIdentity", () => {
  const db = (marker) => ({ query: async () => ({ rows: [{ marker }] }) });

  it("accepts the stack's marker only", async () => {
    await expect(assertStackIdentity(db("m-1"), "m-1")).resolves.toBeUndefined();
    await expect(assertStackIdentity(db("other"), "m-1")).rejects.toThrow(/marker/);
    await expect(assertStackIdentity(db(null), "m-1")).rejects.toThrow(/marker/);
    await expect(assertStackIdentity({ query: async () => ({ rows: [] }) }, "m-1")).rejects.toThrow(
      /marker/,
    );
  });
});
