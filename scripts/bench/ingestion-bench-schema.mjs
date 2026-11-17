// Schema arms of the ingestion benchmark. `baseline` is the committed schema (migrations only).
// `stored-tsv` adds the ADR 0012 column to this run's own disposable database, as its owner role,
// after the migrations and before any document exists. Nothing here touches migration history, a
// role, a policy or an existing grant, and no SQL comes from the command line: both the DDL and
// the catalog queries are the constants below, and the owner session refuses anything else.

import { assertStackIdentity } from "./retrieval-guard.mjs";

export const SCHEMA_ARMS = ["baseline", "stored-tsv"];

// ADR 0012, verbatim in meaning. STORED is explicit (PostgreSQL 18 defaults to virtual) and there is
// deliberately no index. One string, so the simple protocol runs both statements in one transaction.
export const STORED_TSV_DDL = [
  "ALTER TABLE chunks ADD COLUMN content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, content)) STORED NOT NULL;",
  "GRANT SELECT (content_tsv) ON chunks TO contextvault_app;",
].join("\n");

const COLUMNS = "a.attrelid = 'public.chunks'::regclass and a.attnum > 0 and not a.attisdropped";
const can = (role, priv) =>
  `coalesce(json_agg(a.attname order by a.attname) filter (where has_column_privilege('${role}', a.attrelid, a.attnum, '${priv}')), '[]'::json)`;

// Read-only. `selectable` and `updatable` list column names per role, so "unchanged" means the same
// lists before and after, without hard-coding the columns later migrations may add.
// `indexed` sees only indexes that list content_tsv as a plain key: pg_index.indkey holds 0 for expression
// keys and the predicate is not read, so an expression or partial index on it is not detected. The DDL
// creates none; only a hand-modified container could.
export const SNAPSHOT_SQL = `select json_build_object(
  'session', (select json_build_object('user', current_user, 'super', rolsuper, 'bypassRls', rolbypassrls)
    from pg_roles where rolname = current_user),
  'rls', (select json_build_object('enabled', relrowsecurity, 'forced', relforcerowsecurity)
    from pg_class where oid = 'public.chunks'::regclass),
  'policies', (select coalesce(json_agg(json_build_object('name', policyname, 'roles', roles, 'cmd', cmd,
      'using', qual, 'check', with_check) order by policyname), '[]'::json)
    from pg_policies where schemaname = 'public' and tablename = 'chunks'),
  'selectable', (select json_build_object('app', ${can("contextvault_app", "select")},
      'worker', ${can("contextvault_worker", "select")}) from pg_attribute a where ${COLUMNS}),
  'updatable', (select json_build_object('app', ${can("contextvault_app", "update")},
      'worker', ${can("contextvault_worker", "update")}) from pg_attribute a where ${COLUMNS}),
  'column', (select json_build_object('type', format_type(a.atttypid, a.atttypmod),
      'generated', a.attgenerated::text, 'notNull', a.attnotnull,
      'expression', pg_get_expr(d.adbin, d.adrelid))
    from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where ${COLUMNS} and a.attname = 'content_tsv'),
  'indexed', exists (select 1 from pg_index i join pg_attribute a on a.attrelid = i.indrelid
    and a.attnum = any (i.indkey) where i.indrelid = 'public.chunks'::regclass and a.attname = 'content_tsv')
)::text`;

const ALLOWED = new Set([SNAPSHOT_SQL, STORED_TSV_DDL]);

export class SchemaArmError extends Error {}
const refuse = (what) => {
  throw new SchemaArmError(`schema arm refused: ${what}`);
};

/**
 * The expression, parsed from the catalog's own deparse: whitespace, case and parentheses ignored.
 * Only a `pg_catalog.` prefix is dropped, so a function or configuration in any other schema (which
 * pg_get_expr prints qualified when it is not the visible one) does not match. No pg_depend check:
 * built-in functions are pinned objects and record no dependency.
 */
export function expressionIsExpected(text) {
  const flat = String(text ?? "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/pg_catalog\./g, "");
  return /^\(*to_tsvector\('simple'(::regconfig)?,content\)\)*$/.test(flat);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function assertSession({ session }) {
  if (session?.user !== "contextvault_owner") refuse("not the owner role");
  if (session.super || session.bypassRls) refuse("owner session bypasses row-level security");
}

function assertStart(before) {
  assertSession(before);
  const { rls, column, selectable } = before;
  if (!rls?.enabled || !rls.forced) refuse("chunks RLS not forced");
  if (column !== null) refuse("content_tsv exists before the arm was applied");
  if (selectable.worker.includes("content_tsv")) refuse("worker can already read content_tsv");
}

function verifyColumn(c) {
  if (c === null) refuse("content_tsv missing");
  if (c.type !== "tsvector") refuse(`content_tsv type is ${c.type}`);
  if (c.generated !== "s") refuse("content_tsv is not a stored generated column");
  if (c.notNull !== true) refuse("content_tsv is nullable");
  if (!expressionIsExpected(c.expression))
    refuse("generation expression is not to_tsvector('simple'::regconfig, content)");
}

function verifyGrants(before, after) {
  if (!after.selectable.app.includes("content_tsv")) refuse("application role cannot read it");
  if (after.selectable.worker.includes("content_tsv")) refuse("worker role can read it");
  const app = after.selectable.app.filter((n) => n !== "content_tsv");
  if (!same(app, before.selectable.app)) refuse("application column grants changed");
  if (!same(after.selectable.worker, before.selectable.worker)) refuse("worker grants changed");
  if (!same(after.updatable, before.updatable)) refuse("update privileges changed");
}

/** Fails closed unless the catalog shows exactly the ADR column and nothing else changed. */
export function verifyStored(before, after) {
  verifyColumn(after.column);
  if (after.indexed) refuse("content_tsv is indexed");
  verifyGrants(before, after);
  if (!same(after.rls, before.rls) || !same(after.policies, before.policies))
    refuse("row-level security changed");
}

export function verifyBaseline(after) {
  if (after.column !== null) refuse("content_tsv exists in the baseline arm");
}

/** One owner session that answers only the constants above. */
const session = (owner) => async (sql) => {
  if (!ALLOWED.has(sql)) refuse("statement not on the allowed list");
  const { rows } = await owner.query(sql);
  return sql === SNAPSHOT_SQL ? JSON.parse(Object.values(rows[0])[0]) : null;
};

/**
 * Applies and verifies one arm on the connected owner client, recording the outcome in `state`.
 * Throws on any failure; `state.schema.verified` is true only after every check passed.
 */
export async function applySchemaArm({ owner, marker, arm, state }) {
  if (!SCHEMA_ARMS.includes(arm)) refuse("unknown arm");
  state.schema = { arm, verified: false };
  try {
    await assertStackIdentity(owner, marker);
    const run = session(owner);
    const before = await run(SNAPSHOT_SQL);
    assertStart(before);
    if (arm === "stored-tsv") await run(STORED_TSV_DDL);
    const after = await run(SNAPSHOT_SQL);
    if (arm === "stored-tsv") verifyStored(before, after);
    else verifyBaseline(after);
    state.schema = {
      arm,
      verified: true,
      ddl: arm === "stored-tsv" ? STORED_TSV_DDL.split("\n") : [],
      column: after.column,
    };
  } catch (error) {
    state.schema = { arm, verified: false, error: String(error?.message ?? error).slice(0, 300) };
    throw error;
  }
}

/** Connects the owner role, applies the arm, and always closes the session. */
export async function prepareSchema({ pgClient, url, marker, arm, state }) {
  const owner = new pgClient({ connectionString: url });
  await owner.connect();
  try {
    await applySchemaArm({ owner, marker, arm, state });
  } finally {
    await owner.end();
  }
}
