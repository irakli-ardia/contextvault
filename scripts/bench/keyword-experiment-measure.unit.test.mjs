import { describe, expect, it } from "vitest";
import { insertCost, jitOf, storageOf } from "./keyword-experiment-measure.mjs";

/** A client that answers each statement from `reply(sql)` and records what it was asked. */
const client = (reply) => {
  const log = [];
  return {
    log,
    query: async (sql, params) => {
      log.push(sql.trim().split(/\s+/)[0]);
      return reply(sql, params);
    },
  };
};

describe("insertCost", () => {
  it("records the rows actually inserted and rolls every repetition back", async () => {
    const fixture = client((sql) => (sql.includes("insert") ? { rowCount: 1000 } : {}));
    const result = await insertCost(fixture, "w", 1000, 2);
    expect(result).toMatchObject({ requested: 1000, rows: 1000 });
    expect(result.samples).toHaveLength(2);
    expect(fixture.log).toEqual(["begin", "insert", "rollback", "begin", "insert", "rollback"]);
  });

  it("fails, after rolling back, when fewer rows were inserted than requested", async () => {
    const fixture = client((sql) => (sql.includes("insert") ? { rowCount: 1000 } : {}));
    await expect(insertCost(fixture, "w", 5000, 3)).rejects.toThrow("1000 rows inserted, 5000");
    expect(fixture.log).toEqual(["begin", "insert", "rollback"]);
  });
});

describe("storageOf", () => {
  const sizes = { table_bytes: "10", indexes_bytes: "2", total_bytes: "12", new_index_bytes: "0" };
  const owner = client(() => ({ rows: [sizes] }));
  const reader = (row) => client(() => ({ rows: [row] }));

  it("reads relation sizes as the owner and the column through the reader", async () => {
    const result = await storageOf(
      owner,
      { indexes: [], column: "content_tsv" },
      reader({ rows: "2", bytes: "9" }),
    );
    expect(result).toEqual({ ...sizes, columnBytes: "9", columnRows: "2" });
  });

  it("reports no column size for a variant without a stored column, and never reads rows", async () => {
    const unused = reader({});
    expect(await storageOf(owner, { indexes: [] }, unused)).toEqual({
      ...sizes,
      columnBytes: null,
    });
    expect(unused.log).toEqual([]);
  });

  it.each([
    ["no rows visible", { rows: "0", bytes: null }],
    ["a null sum", { rows: "5", bytes: null }],
  ])("throws instead of recording a missing measurement (%s)", async (_name, row) => {
    await expect(
      storageOf(owner, { indexes: [], column: "content_tsv" }, reader(row)),
    ).rejects.toThrow("column size unavailable");
  });
});

describe("jitOf", () => {
  it("distinguishes a compiled plan from one without JIT", () => {
    expect(jitOf({ JIT: { Functions: 12, Timing: { Total: 41.5 } } })).toEqual({
      used: true,
      functions: 12,
      totalMs: 41.5,
    });
    expect(jitOf({ Plan: {} })).toEqual({ used: false });
  });
});
