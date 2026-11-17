import { describe, expect, it } from "vitest";
import {
  applySchemaArm,
  expressionIsExpected,
  SNAPSHOT_SQL,
  STORED_TSV_DDL,
} from "./ingestion-bench-schema.mjs";

const BASE_APP = ["content", "end_offset", "id", "start_offset", "version_id", "workspace_id"];
const BASE_WORKER = ["id", "version_id", "workspace_id"];
const COLUMN = {
  type: "tsvector",
  generated: "s",
  notNull: true,
  expression: "to_tsvector('simple'::regconfig, content)",
};
const snapshot = (over = {}) => ({
  session: { user: "contextvault_owner", super: false, bypassRls: false },
  rls: { enabled: true, forced: true },
  policies: [{ name: "chunks_app_select", cmd: "SELECT" }],
  selectable: { app: BASE_APP, worker: BASE_WORKER },
  updatable: { app: [], worker: [] },
  column: null,
  indexed: false,
  ...over,
});
const stored = (over = {}) =>
  snapshot({
    column: { ...COLUMN, ...over.column },
    selectable: { app: [...BASE_APP, "content_tsv"], worker: BASE_WORKER },
    ...over.rest,
  });

/** An owner session double: answers the marker query and each snapshot in turn, records the order. */
function owner({ marker = "m1", snapshots, ddlFails = false }) {
  const calls = [];
  const queue = [...snapshots];
  return {
    calls,
    query: async (sql) => {
      if (sql.includes("shobj_description")) {
        calls.push("identity");
        return { rows: [{ marker }] };
      }
      if (sql === STORED_TSV_DDL) {
        calls.push("ddl");
        if (ddlFails) throw new Error("ddl boom");
        return { rows: [] };
      }
      if (sql === SNAPSHOT_SQL) {
        calls.push("snapshot");
        return { rows: [{ json_build_object: JSON.stringify(queue.shift()) }] };
      }
      calls.push(`unexpected:${sql}`);
      return { rows: [] };
    },
  };
}
const apply = (arm, o) => {
  const state = {};
  return applySchemaArm({ owner: o, marker: "m1", arm, state }).then(
    () => state,
    (error) => Object.assign(state, { thrown: error.message }),
  );
};

describe("stored-tsv definition", () => {
  it("is exactly the ADR 0012 DDL and grant, with no index or other privilege change", () => {
    expect(STORED_TSV_DDL.split("\n")).toEqual([
      "ALTER TABLE chunks ADD COLUMN content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, content)) STORED NOT NULL;",
      "GRANT SELECT (content_tsv) ON chunks TO contextvault_app;",
    ]);
    expect(STORED_TSV_DDL).not.toMatch(/virtual|index|worker|policy|alter role|row level/i);
  });
  it("matches the expression by meaning, not by spacing, case or parentheses", () => {
    for (const text of [
      "to_tsvector('simple'::regconfig, content)",
      " TO_TSVECTOR( 'simple'::regconfig ,\n content ) ",
      "(to_tsvector('simple'::regconfig, content))",
      "pg_catalog.to_tsvector('simple'::regconfig, content)",
    ])
      expect(expressionIsExpected(text)).toBe(true);
    for (const text of [
      "to_tsvector('english'::regconfig, content)",
      "to_tsvector('simple'::regconfig, content || 'x')",
      "to_tsvector('simple'::regconfig, id::text)",
      "public.to_tsvector('simple'::regconfig, content)",
      "pg_catalog.to_tsvector('public.simple'::regconfig, content)",
      "to_tsvector('simple'::regconfig, content_other)",
      "to_tsvector('simple'::regconfig, content) || to_tsvector('simple'::regconfig, content)",
      "to_tsvector(content)",
      null,
    ])
      expect(expressionIsExpected(text)).toBe(false);
  });
});

describe("baseline arm", () => {
  it("verifies that content_tsv is absent, applies nothing and records the arm", async () => {
    const o = owner({ snapshots: [snapshot(), snapshot()] });
    const state = await apply("baseline", o);
    expect(o.calls).toEqual(["identity", "snapshot", "snapshot"]);
    expect(state.schema).toEqual({ arm: "baseline", verified: true, ddl: [], column: null });
  });
  it("refuses a database that already has the column", async () => {
    const o = owner({ snapshots: [stored()] });
    expect((await apply("baseline", o)).thrown).toMatch(/exists before/);
    expect(o.calls).not.toContain("ddl");
  });
});

describe("stored-tsv arm", () => {
  it("runs identity, snapshot, DDL, snapshot, verifies, and records the column", async () => {
    const o = owner({ snapshots: [snapshot(), stored()] });
    const state = await apply("stored-tsv", o);
    expect(o.calls).toEqual(["identity", "snapshot", "ddl", "snapshot"]);
    expect(state.schema).toMatchObject({ arm: "stored-tsv", verified: true, column: COLUMN });
  });
  it.each([
    [
      "wrong expression",
      { column: { expression: "to_tsvector('english'::regconfig, content)" } },
      /expression/,
    ],
    [
      "shadowing function in another schema",
      { column: { expression: "public.to_tsvector('simple'::regconfig, content)" } },
      /expression/,
    ],
    [
      "configuration in another schema",
      { column: { expression: "to_tsvector('public.simple'::regconfig, content)" } },
      /expression/,
    ],
    [
      "different source column",
      { column: { expression: "to_tsvector('simple'::regconfig, id::text)" } },
      /expression/,
    ],
    ["missing expression", { column: { expression: null } }, /expression/],
    ["virtual column", { column: { generated: "v" } }, /not a stored/],
    ["not generated", { column: { generated: "" } }, /not a stored/],
    ["nullable", { column: { notNull: false } }, /nullable/],
    ["wrong type", { column: { type: "text" } }, /type is text/],
    ["indexed", { rest: { indexed: true } }, /indexed/],
    [
      "app cannot read",
      { rest: { selectable: { app: BASE_APP, worker: BASE_WORKER } } },
      /application role/,
    ],
    [
      "worker can read",
      {
        rest: {
          selectable: {
            app: [...BASE_APP, "content_tsv"],
            worker: [...BASE_WORKER, "content_tsv"],
          },
        },
      },
      /worker role can read/,
    ],
    [
      "app grant widened",
      { rest: { selectable: { app: [...BASE_APP, "content_tsv", "extra"], worker: BASE_WORKER } } },
      /application column grants/,
    ],
    [
      "update granted",
      { rest: { updatable: { app: ["content_tsv"], worker: [] } } },
      /update privileges/,
    ],
    ["policy changed", { rest: { policies: [] } }, /row-level security/],
    ["RLS relaxed", { rest: { rls: { enabled: true, forced: false } } }, /row-level security/],
  ])("fails closed: %s", async (_name, over, message) => {
    const state = await apply("stored-tsv", owner({ snapshots: [snapshot(), stored(over)] }));
    expect(state.thrown).toMatch(message);
    expect(state.schema).toMatchObject({ arm: "stored-tsv", verified: false });
    expect(state.schema.error).toMatch(message);
  });
  it.each([
    ["a superuser session", { session: { user: "contextvault_owner", super: true } }],
    ["the wrong role", { session: { user: "contextvault_app", super: false } }],
    ["RLS not forced", { rls: { enabled: true, forced: false } }],
    ["worker already reads it", { selectable: { app: BASE_APP, worker: ["content_tsv"] } }],
  ])("refuses before any DDL: %s", async (_name, over) => {
    const o = owner({ snapshots: [snapshot(over)] });
    expect((await apply("stored-tsv", o)).thrown).toMatch(/refused/);
    expect(o.calls).not.toContain("ddl");
  });
  it("refuses a mismatched container identity before anything else", async () => {
    const o = owner({ marker: "other", snapshots: [] });
    expect((await apply("stored-tsv", o)).thrown).toMatch(/marker/);
    expect(o.calls).toEqual(["identity"]);
  });
  it("records a failing DDL and does not verify", async () => {
    const o = owner({ snapshots: [snapshot()], ddlFails: true });
    const state = await apply("stored-tsv", o);
    expect(state.thrown).toBe("ddl boom");
    expect(state.schema).toMatchObject({ verified: false, error: "ddl boom" });
  });
  it("refuses an unknown arm and any SQL outside its constants", async () => {
    expect((await apply("custom", owner({ snapshots: [] }))).thrown).toMatch(/unknown arm/);
    expect(SNAPSHOT_SQL.trimStart()).toMatch(/^select /);
    const code = SNAPSHOT_SQL.replace(/'[^']*'/g, "''");
    expect(code).not.toMatch(/\b(insert|update|delete|alter|grant|create|drop)\b/i);
  });
});
