import { describe, expect, it } from "vitest";
import { classify, summarize } from "./ingestion-bench-server-stats-rules.mjs";

const entry = (role, query, over = {}) => ({
  role,
  query,
  calls: 2,
  rows: 4,
  totalExecMs: 10,
  minExecMs: 4,
  maxExecMs: 6,
  stddevExecMs: 1,
  sharedBlksHit: 1,
  sharedBlksRead: 0,
  sharedBlksDirtied: 0,
  sharedBlksWritten: 0,
  walBytes: 100,
  walRecords: 1,
  walFpi: 0,
  ...over,
});
const W = "contextvault_worker";
const info = { dealloc: 0, statsReset: "2026-11-16T10:00:00Z" };

describe("zero-call entries", () => {
  const zero = (query, over = {}) =>
    entry(W, query, {
      calls: 0,
      totalExecMs: 0,
      minExecMs: 0,
      maxExecMs: 0,
      stddevExecMs: 0,
      rows: 0,
      ...over,
    });
  const chunk = 'insert into "chunks" values ($1)';
  const finite = (value) => {
    if (value === null || typeof value !== "object") {
      return value === null || typeof value !== "number" || Number.isFinite(value);
    }
    return Object.values(value).every(finite);
  };

  it("are ignored in timing, min and max when mixed with executed entries", () => {
    const out = summarize({
      rows: [
        zero(chunk),
        entry(W, chunk, { calls: 2, totalExecMs: 10, minExecMs: 4, maxExecMs: 6 }),
      ],
      info,
      client: { chunks: 2 },
    });
    expect(out.classes.chunks).toMatchObject({
      calls: 2,
      meanExecMs: 5,
      minExecMs: 4,
      maxExecMs: 6,
      callsMatch: true,
    });
    expect(out.classes.chunks.stddevExecMs).toBeCloseTo(1, 10);
    expect(out.valid).toBe(true);
  });
  it("leave pooled variance over several executed entries unchanged", () => {
    const rows = [
      entry(W, chunk, { calls: 2, totalExecMs: 10, minExecMs: 4, maxExecMs: 6 }),
      entry(W, `${chunk}, ($2)`, { calls: 2, totalExecMs: 30, minExecMs: 14, maxExecMs: 16 }),
    ];
    const plain = summarize({ rows, info, client: { chunks: 4 } });
    const withZero = summarize({
      rows: [zero(chunk), ...rows, zero("COMMIT")],
      info,
      client: { chunks: 4 },
    });
    expect(plain.classes.chunks.stddevExecMs).toBeCloseTo(Math.sqrt(26), 10);
    expect(withZero.classes.chunks).toEqual(plain.classes.chunks);
  });
  it("alone give calls 0 and null timings, never zero or NaN", () => {
    const out = summarize({ rows: [zero(chunk), zero("COMMIT")], info, client: {} });
    expect(out.classes.chunks).toMatchObject({
      calls: 0,
      meanExecMs: null,
      minExecMs: null,
      maxExecMs: null,
      stddevExecMs: null,
      callsMatch: true,
    });
    expect(out.classes.commit.meanExecMs).toBeNull();
  });
  it("make a window invalid when no worker statement executed, even with no client statements", () => {
    const out = summarize({ rows: [zero(chunk), zero("COMMIT")], info, client: {} });
    expect(out.valid).toBe(false);
    expect(out.invalidReasons).toContain("no worker-role statements recorded");
  });
  it("keep a window with one executed entry valid beside zero-call ones", () => {
    const out = summarize({
      rows: [zero(chunk), entry(W, "COMMIT", { calls: 1, stddevExecMs: 0 })],
      info,
      client: {},
    });
    expect(out.valid).toBe(true);
  });
  it("do not hide missing executions: the client saw statements the server never ran", () => {
    const out = summarize({ rows: [zero(chunk)], info, client: { chunks: 3 } });
    expect(out.valid).toBe(false);
    expect(out.invalidReasons.join()).toMatch(/chunks: server 0 calls, client 3/);
  });
  it("leave a result with no invalid numbers once serialized", () => {
    const out = summarize({
      rows: [zero(chunk), zero("select 1"), entry(W, "COMMIT", { calls: 1, stddevExecMs: 0 })],
      info,
      client: {},
    });
    expect(finite(out)).toBe(true);
    expect(JSON.stringify(out)).not.toMatch(/NaN|Infinity/);
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
  });
});

describe("classify on a statement read from both ends", () => {
  it("still finds a class defined by the tail", () => {
    const head = `select d.id from documents d join document_versions dv on dv.id = $1 ${"and x = $2 ".repeat(40)}`;
    const text = `${head.slice(0, 600)} ${"...".repeat(10)} where y = $3 for no key update of dv`;
    expect(classify(text)).toBe("lockVersion");
  });
  it("leaves an unrelated long statement unclassified", () => {
    expect(classify(`select ${"a, ".repeat(500)} from t`)).toBe("other");
  });
});
