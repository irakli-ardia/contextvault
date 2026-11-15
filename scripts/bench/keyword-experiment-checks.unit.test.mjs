import { describe, expect, it } from "vitest";
import {
  assertAnalyzed,
  assertAppRole,
  compareRows,
  expectedRows,
  ginUsed,
  isolationFailures,
  planIndexNames,
  skippedTables,
  TENANT_TABLES,
} from "./keyword-experiment-checks.mjs";
import {
  ADD_COLUMN,
  GRANT_COLUMN,
  useStoredColumn,
  VARIANTS,
} from "./keyword-experiment-variants.mjs";

const row = (chunkId, score) => ({ chunkId, score });

describe("compareRows", () => {
  const reference = [row("a", 0.3), row("b", 0.2)];
  it("accepts identical ids, order and scores", () => {
    expect(compareRows(reference, [row("a", 0.3), row("b", 0.2)]).identical).toBe(true);
    expect(compareRows([], []).identical).toBe(true);
  });
  it.each([
    ["a different order", [row("b", 0.2), row("a", 0.3)]],
    ["a different score", [row("a", 0.3), row("b", 0.2000001)]],
    ["a missing row", [row("a", 0.3)]],
    ["an extra row", [...reference, row("c", 0.1)]],
  ])("rejects %s", (_label, candidate) => {
    expect(compareRows(reference, candidate).identical).toBe(false);
  });
});

describe("expectedRows", () => {
  it("is the planted frequency capped at the limit", () => {
    expect(expectedRows(10, 50)).toBe(10);
    expect(expectedRows(25_000, 50)).toBe(50);
    expect(expectedRows(0, 50)).toBe(0);
  });
});

const scan = (type, index, plans = []) => ({
  "Node Type": type,
  "Index Name": index,
  Plans: plans,
});

describe("planIndexNames and ginUsed", () => {
  const plan = {
    Plan: {
      "Node Type": "Limit",
      Plans: [
        scan("Index Scan", "chunks_workspace_version_idx"),
        scan("Bitmap Heap Scan", undefined, [scan("Bitmap Index Scan", "kw_exp_gin_stored")]),
      ],
    },
  };
  it("lists every index in the plan tree, once", () => {
    expect(planIndexNames(plan)).toEqual(["chunks_workspace_version_idx", "kw_exp_gin_stored"]);
    expect(planIndexNames({ Plan: { "Node Type": "Seq Scan" } })).toEqual([]);
  });
  it("counts only the experiment's own indexes, never the base tables' btrees", () => {
    expect(ginUsed(["chunks_workspace_version_idx"], ["kw_exp_gin_stored"])).toBe(false);
    expect(ginUsed(planIndexNames(plan), ["kw_exp_gin_stored"])).toBe(true);
    expect(ginUsed(planIndexNames(plan), [])).toBe(false);
  });
});

describe("planner statistics", () => {
  it("accepts tables with statistics and rejects unanalyzed or missing ones", async () => {
    const db = (rows) => ({ query: async () => ({ rows }) });
    await expect(assertAnalyzed(db([]), ["chunks"])).resolves.toBeUndefined();
    await expect(assertAnalyzed(db([{ relname: "documents" }]), ["documents"])).rejects.toThrow(
      /documents/,
    );
  });
  it("recognises the notice that a table was skipped", () => {
    expect(
      skippedTables(['skipping "documents" --- only table or database owner can analyze it', "ok"]),
    ).toHaveLength(1);
    expect(skippedTables(["nothing"])).toEqual([]);
  });
});

describe("isolationFailures", () => {
  const aIds = new Set(["a1", "a2"]);
  const bIds = new Set(["b1"]);
  const clean = {
    aIds,
    bIds,
    limit: 50,
    aOwn: [row("a1", 1), row("a2", 1)],
    bOwn: [row("b1", 1)],
    crossings: { "A context, B workspace": [], "no context": [] },
  };
  it("passes when each control finds exactly its own rows and every crossing is empty", () => {
    expect(isolationFailures(clean)).toEqual([]);
  });
  it.each([
    ["a leak through a crossing", { crossings: { "A context, B workspace": [row("b1", 1)] } }],
    ["a leak without context", { crossings: { "no context": [row("a1", 1)] } }],
    ["A's control leaving A", { aOwn: [row("a1", 1), row("b1", 1)] }],
    ["B's control leaving B", { bOwn: [row("a1", 1)] }],
    ["a control that found too little (the test would prove nothing)", { bOwn: [] }],
    ["a control that found too much", { aOwn: [row("a1", 1), row("a2", 1), row("a3", 1)] }],
  ])("fails on %s", (_label, patch) => {
    expect(isolationFailures({ ...clean, ...patch })).not.toEqual([]);
  });
  it("caps the expected control at the search limit", () => {
    const many = new Set(Array.from({ length: 200 }, (_, i) => `a${i}`));
    const fifty = [...many].slice(0, 50).map((id) => row(id, 1));
    expect(isolationFailures({ ...clean, aIds: many, aOwn: fifty })).toEqual([]);
  });
});

describe("assertAppRole", () => {
  const app = { name: "contextvault_app", rolsuper: false, rolbypassrls: false };
  const tables = TENANT_TABLES.map((relname) => ({ relname, forced: true }));
  const db = ({ role = app, timeout = "15s", rows = tables } = {}) => ({
    query: async (text) => {
      if (text.includes("pg_roles")) return { rows: [role] };
      if (text.includes("statement_timeout")) return { rows: [{ statement_timeout: timeout }] };
      return { rows };
    },
  });
  it("accepts the application role and returns what it verified", async () => {
    await expect(assertAppRole(db())).resolves.toEqual({
      statementTimeout: "15s",
      forcedRlsTables: [...TENANT_TABLES].sort(),
    });
  });
  it.each([
    ["another role", { role: { ...app, name: "contextvault_fixture" } }, /not contextvault_app/],
    ["BYPASSRLS", { role: { ...app, rolbypassrls: true } }, /bypasses RLS/],
    ["superuser", { role: { ...app, rolsuper: true } }, /bypasses RLS/],
    ["a longer timeout", { timeout: "2min" }, /statement_timeout is not 15s/],
    ["no timeout", { timeout: "0" }, /statement_timeout is not 15s/],
    [
      "a table without forced RLS",
      { rows: tables.map((t) => (t.relname === "chunks" ? { ...t, forced: false } : t)) },
      /not forced on: chunks/,
    ],
    [
      "a missing table",
      { rows: tables.filter((t) => t.relname !== "documents") },
      /tenant tables missing: documents/,
    ],
    ["no tables at all", { rows: [] }, /tenant tables missing: workspaces, memberships/],
  ])("rejects %s", async (_name, options, message) => {
    await expect(assertAppRole(db(options))).rejects.toThrow(message);
  });
});

describe("variants", () => {
  const statement =
    "select ts_rank_cd(to_tsvector('simple', c.content), q) from chunks c where to_tsvector('simple', c.content) @@ q";
  it("swaps both tsvector expressions for the stored column", () => {
    const sql = useStoredColumn(statement);
    expect(sql).toBe("select ts_rank_cd(c.content_tsv, q) from chunks c where c.content_tsv @@ q");
  });
  it("refuses a statement that no longer has exactly two expressions", () => {
    expect(() => useStoredColumn("select 1")).toThrow(/expected 2/);
    expect(() => useStoredColumn(`${statement} ${statement}`)).toThrow(/expected 2/);
  });
  it("covers the baseline and three candidates", () => {
    expect(VARIANTS.map((v) => v.key)).toEqual([
      "baseline",
      "gin_expression",
      "stored",
      "stored_gin",
    ]);
    expect(VARIANTS[0].rewrite(statement)).toBe(statement);
  });
});

describe("variant construction", () => {
  const stored = VARIANTS.filter((v) => v.column);
  it("adds an explicitly STORED generated column, never a virtual one", () => {
    expect(ADD_COLUMN).toMatch(/generated always as \(.+\) stored$/);
    expect(ADD_COLUMN).not.toMatch(/virtual/i);
    for (const variant of stored) expect(variant.build).toContain(ADD_COLUMN);
    expect(stored.map((v) => v.key)).toEqual(["stored", "stored_gin"]);
  });
  it("grants the application role the new column in both stored variants only", () => {
    expect(GRANT_COLUMN).toBe("grant select (content_tsv) on chunks to contextvault_app");
    for (const variant of VARIANTS) {
      expect(variant.build.includes(GRANT_COLUMN)).toBe(Boolean(variant.column));
    }
  });
  it("creates each stored GIN index after its column and grant", () => {
    const build = VARIANTS.find((v) => v.key === "stored_gin").build;
    expect(build.at(-1)).toMatch(/^create index kw_exp_gin_stored .* gin \(content_tsv\)$/);
  });
});

describe("against the production statement", () => {
  it("rewrites the keyword SQL the repository really renders", async () => {
    // Source is imported directly (no build step), so this stays fast and deterministic.
    const { createSearchRepository } = await import(
      "../../packages/db/src/repositories/retrieval/search-repository.ts"
    );
    const { PgDialect } = await import(
      "../../packages/db/node_modules/drizzle-orm/pg-core/index.js"
    );
    const dialect = new PgDialect();
    let rendered;
    const executor = {
      execute: async (statement) => {
        rendered = dialect.sqlToQuery(statement).sql;
        return { rows: [] };
      },
    };
    await createSearchRepository(executor).keyword({ workspaceId: "w", query: "q", limit: 5 });
    const stored = useStoredColumn(rendered);
    expect(stored).not.toContain("to_tsvector");
    expect(stored.match(/c\.content_tsv/g)).toHaveLength(2);
    expect(stored).toContain("websearch_to_tsquery('simple'");
  });
});
