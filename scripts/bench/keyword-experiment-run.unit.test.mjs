import { describe, expect, it } from "vitest";
import { CheckFailure } from "./keyword-experiment-checks.mjs";
import { measureVariant } from "./keyword-experiment-run.mjs";

const variant = { key: "stored", label: "Stored column" };
const env = { variant, owner: "owner", fixture: "fixture", a: { workspace: "wa" } };
const cases = [{ key: "rare" }, { key: "common" }, { key: "absent" }];

const steps = (overrides = {}) => ({
  applyVariant: async () => [{ statement: "build", ms: 1 }],
  measureCase: async (_env, c) => ({
    key: c.key,
    rows: [1],
    countOk: true,
    sameAsBaseline: { identical: true },
    appExplain: { source: "app" },
  }),
  storageOf: async () => ({ bytes: 10 }),
  insertCost: async () => ({ median: 2 }),
  isolationOf: async () => ({ passed: true, failures: [] }),
  ...overrides,
});
const run = (state, overrides) =>
  measureVariant(env, cases, undefined, state, () => {}, steps(overrides));

describe("measureVariant", () => {
  it("records a finished variant as complete, without the raw rows", async () => {
    const state = { variants: [] };
    const results = await run(state);
    expect(results.map((r) => r.rows)).toEqual([[1], [1], [1]]);
    const [entry] = state.variants;
    expect(entry).toMatchObject({ key: "stored", complete: true, storage: { bytes: 10 } });
    expect(entry.cases.map((c) => c.key)).toEqual(["rare", "common", "absent"]);
    expect(entry.cases.every((c) => c.rows === undefined)).toBe(true);
  });

  it("keeps the cases measured before a failure, marked incomplete", async () => {
    const state = { variants: [] };
    const measureCase = async (_env, c) => {
      if (c.key === "absent") throw new Error("boom");
      return { key: c.key, rows: [], appExplain: { source: "app" } };
    };
    await expect(run(state, { measureCase })).rejects.toThrow("boom");
    const [entry] = state.variants;
    expect(entry.complete).toBe(false);
    expect(entry.cases.map((c) => c.key)).toEqual(["rare", "common"]);
    expect(entry.buildMs).toHaveLength(1);
    expect(entry.isolation).toBeUndefined();
  });

  it("keeps a variant whose build failed, with no cases", async () => {
    const state = { variants: [] };
    const applyVariant = async () => {
      throw new Error("ddl");
    };
    await expect(run(state, { applyVariant })).rejects.toThrow("ddl");
    expect(state.variants).toEqual([
      { key: "stored", label: "Stored column", complete: false, cases: [] },
    ]);
  });

  it("compares each case with the baseline's rows", async () => {
    const seen = [];
    const measureCase = async (_env, c, reference) => {
      seen.push([c.key, reference]);
      return {
        key: c.key,
        rows: [],
        countOk: true,
        sameAsBaseline: { identical: true },
        appExplain: { source: "app" },
      };
    };
    await measureVariant(
      { ...env },
      cases,
      { rare: [7] },
      { variants: [] },
      () => {},
      steps({ measureCase }),
    );
    expect(seen).toEqual([
      ["rare", [7]],
      ["common", undefined],
      ["absent", undefined],
    ]);
  });

  it.each([
    [
      "a tenant leak",
      { isolationOf: async () => ({ passed: false, failures: ["leak"] }) },
      /isolation/,
    ],
    [
      "a wrong row count",
      {
        measureCase: async (_env, c) => ({
          key: c.key,
          rows: [],
          appExplain: { source: "app" },
          countOk: c.key !== "common",
          sameAsBaseline: { identical: true },
        }),
      },
      /common: unexpected row count/,
    ],
    [
      "rows unlike the baseline",
      {
        measureCase: async (_env, c) => ({
          key: c.key,
          rows: [],
          appExplain: { source: "app" },
          countOk: true,
          sameAsBaseline: { identical: c.key !== "rare", reason: "row 0 differs" },
        }),
      },
      /rare: rows differ from baseline/,
    ],
  ])("fails closed on %s but keeps every measurement", async (_name, overrides, message) => {
    const state = { variants: [] };
    const failure = await run(state, overrides).catch((error) => error);
    expect(failure).toBeInstanceOf(CheckFailure);
    expect(failure.message).toMatch(message);
    const [entry] = state.variants;
    expect(entry).toMatchObject({ complete: true, storage: { bytes: 10 } });
    expect(entry.cases.map((c) => c.key)).toEqual(["rare", "common", "absent"]);
    expect(entry.failures.length).toBeGreaterThan(0);
  });
});

describe("measureVariant arguments", () => {
  it("measures the stored column through the fixture role and inserts the requested rows", async () => {
    const calls = [];
    const record =
      (name) =>
      async (...args) => {
        calls.push([name, ...args]);
        return {};
      };
    await measureVariant(
      { ...env, insertRows: 1000 },
      [],
      undefined,
      { variants: [] },
      () => {},
      steps({ storageOf: record("storage"), insertCost: record("insert") }),
    );
    expect(calls).toEqual([
      ["storage", "owner", variant, "fixture"],
      ["insert", "fixture", "wa", 1000],
    ]);
  });
});
