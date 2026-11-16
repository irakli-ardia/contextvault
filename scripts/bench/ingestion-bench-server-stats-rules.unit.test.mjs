import { describe, expect, it } from "vitest";
import { leaks } from "./ingestion-bench-provenance.mjs";
import {
  classify,
  clientCounts,
  parseLockWaits,
  summarize,
} from "./ingestion-bench-server-stats-rules.mjs";

describe("classify (normalized server text)", () => {
  it.each([
    ["BEGIN", "begin"],
    ["COMMIT", "commit"],
    ["ROLLBACK", "rollback"],
    ['insert into "sections" ("id", "title") values ($1, $2), ($3, $4)', "sections"],
    ['insert into "chunks" ("id") values ($1)', "chunks"],
    ['insert into "chunk_embeddings" ("chunk_id") values ($1), ($2), ($3)', "embeddings"],
    [
      "\n    update document_versions dv set status = $1, updated_at = now()\n    where x",
      "markReady",
    ],
    ["update documents d set active_version_id = $1 where d.id = $2 returning d.id", "movePointer"],
    ["select 1 from document_versions dv where dv.id = $1 for no key update of dv", "lockVersion"],
    ["select d.id from documents d where d.id = $1 for no key update of d", "lockDocument"],
    ["update document_versions dv set status = $1, lease_generation = 1", "other"],
    ["select set_config($1, $2, true)", "other"],
    ["", "other"],
  ])("%j is %s", (query, expected) => expect(classify(query)).toBe(expected));
});

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
const tx = (labels) => ({ labels });

describe("summarize", () => {
  it("sums entries of one class (different row counts) and pools the deviation", () => {
    const out = summarize({
      rows: [
        entry(W, 'insert into "chunks" values ($1)', { calls: 2, totalExecMs: 10 }),
        entry(W, 'insert into "chunks" values ($1), ($2)', {
          calls: 2,
          totalExecMs: 30,
          minExecMs: 14,
          maxExecMs: 16,
        }),
      ],
      info,
      client: { chunks: 4 },
    });
    expect(out.valid).toBe(true);
    expect(out.classes.chunks).toMatchObject({
      calls: 4,
      totalExecMs: 40,
      meanExecMs: 10,
      minExecMs: 4,
      maxExecMs: 16,
      clientCalls: 4,
      callsMatch: true,
    });
    expect(out.classes.chunks.stddevExecMs).toBeCloseTo(Math.sqrt(1 + (25 + 225) / 2 - 100 + 0), 5);
  });
  it("marks the scenario invalid on a call-count discrepancy, either direction", () => {
    const more = summarize({
      rows: [entry(W, 'insert into "chunks" values ($1)')],
      info,
      client: { chunks: 3 },
    });
    expect(more.valid).toBe(false);
    expect(more.invalidReasons[0]).toMatch(/chunks: server 2 calls, client 3/);
    const none = summarize({ rows: [entry(W, "select 1")], info, client: { markReady: 1 } });
    expect(none.invalidReasons.join()).toMatch(/markReady: client 1 statements, none recorded/);
  });
  it("leaves the check unavailable, not equal, when the client saw an error of that class", () => {
    const out = summarize({
      rows: [entry(W, 'insert into "chunks" values ($1)')],
      info,
      client: { chunks: 3 },
      clientErrors: [{ label: "chunks", code: "57014" }],
    });
    expect(out.classes.chunks.callsMatch).toBeNull();
    expect(out.valid).toBe(true);
  });
  it("does not validate transaction control or unclassified statements", () => {
    const out = summarize({
      rows: [entry(W, "COMMIT"), entry(W, "select set_config($1)")],
      info,
      client: { commit: 99 },
    });
    expect(out.classes.commit).toMatchObject({ clientCalls: null, callsMatch: null });
    expect(out.other).toMatchObject({ calls: 2 });
    expect(out.valid).toBe(true);
  });
  it("is invalid after evictions, with missing info, or with nothing recorded", () => {
    expect(
      summarize({ rows: [entry(W, "select 1")], info: { ...info, dealloc: 3 }, client: {} })
        .invalidReasons[0],
    ).toMatch(/3 statement entries were evicted/);
    expect(summarize({ rows: [entry(W, "select 1")], info: null, client: {} }).valid).toBe(false);
    expect(summarize({ rows: [], info, client: {} }).invalidReasons).toContain(
      "no worker-role statements recorded",
    );
  });
  it("keeps app-role rows out of the worker figures and only counts them", () => {
    const out = summarize({
      rows: [entry(W, "select 1"), entry("contextvault_app", "select 2")],
      info,
      client: {},
    });
    expect(out.appRoleCalls).toBe(2);
    expect(out.other.calls).toBe(2);
  });
  it("carries no query text or identifier into the result", () => {
    const secret = "select * from users where token = $1 /home/someone/.env";
    const text = JSON.stringify(summarize({ rows: [entry(W, secret)], info, client: {} }));
    expect(text).not.toContain("select *");
    expect(text).not.toContain("queryid");
    expect(leaks(text)).toEqual([]);
  });
});

describe("clientCounts", () => {
  it("sums statements per label over every transaction in the window", () => {
    expect(clientCounts([tx({ chunks: [1, 2], begin: [1] }), tx({ chunks: [3] })])).toEqual({
      chunks: 3,
      begin: 1,
    });
  });
});

describe("parseLockWaits", () => {
  it("keeps counts and durations only", () => {
    const text = [
      "LOG:  process 9 still waiting for ShareLock on transaction 77 after 100.317 ms",
      "DETAIL:  Process holding the lock: 8. Wait queue: 9.",
      "STATEMENT:  update secret_table set x = 'private'",
      "LOG:  process 9 acquired ShareLock on transaction 77 after 412.5 ms",
      "LOG:  checkpoint starting",
    ].join("\n");
    const waits = parseLockWaits(text);
    expect(waits).toEqual({ count: 1, resolved: 1, totalMs: 412.5, maxMs: 412.5 });
    expect(JSON.stringify(waits)).not.toMatch(/secret|private/);
  });
  it("is zero for a quiet log", () =>
    expect(parseLockWaits("")).toEqual({ count: 0, resolved: 0, totalMs: 0, maxMs: 0 }));
});
