// Deterministic pass/fail rules of the keyword-search experiment. Pure apart from `assertAppRole`,
// which only reads the catalog.

export const TENANT_TABLES = [
  "workspaces",
  "memberships",
  "documents",
  "document_versions",
  "chunks",
];

export const APP_STATEMENT_TIMEOUT = "15s";

/**
 * The experiment must run as the real application role: not a superuser, no BYPASSRLS, the
 * production statement_timeout, and every tenant table present with RLS enabled and forced.
 * Returns what was verified, for the result file.
 */
export async function assertAppRole(db) {
  const { rows } = await db.query(
    "select current_user as name, rolsuper, rolbypassrls from pg_roles where rolname = current_user",
  );
  const [role] = rows;
  if (role?.name !== "contextvault_app") throw new Error("connection is not contextvault_app");
  if (role.rolsuper || role.rolbypassrls) throw new Error("application role bypasses RLS");
  const {
    rows: [setting],
  } = await db.query("show statement_timeout");
  const statementTimeout = setting?.statement_timeout;
  if (statementTimeout !== APP_STATEMENT_TIMEOUT) {
    throw new Error(`application statement_timeout is not ${APP_STATEMENT_TIMEOUT}`);
  }
  const { rows: tables } = await db.query(
    `select relname, relrowsecurity and relforcerowsecurity as forced from pg_class
     where relnamespace = 'public'::regnamespace and relkind = 'r' and relname = any($1)`,
    [TENANT_TABLES],
  );
  const present = new Set(tables.map((t) => t.relname));
  const missing = TENANT_TABLES.filter((name) => !present.has(name));
  if (missing.length > 0) throw new Error(`tenant tables missing: ${missing.join(", ")}`);
  const weak = tables.filter((t) => !t.forced);
  if (weak.length > 0) throw new Error(`RLS is not forced on: ${weak.map((t) => t.relname)}`);
  return { statementTimeout, forcedRlsTables: [...TENANT_TABLES].sort() };
}

/** Same rows, same order, same scores: the candidate must be indistinguishable from the baseline. */
export function compareRows(reference, candidate) {
  if (reference.length !== candidate.length) {
    return { identical: false, reason: `${candidate.length} rows, expected ${reference.length}` };
  }
  const at = reference.findIndex(
    (row, i) => row.chunkId !== candidate[i].chunkId || row.score !== candidate[i].score,
  );
  return at === -1 ? { identical: true } : { identical: false, reason: `row ${at} differs` };
}

/** The planted term frequency fixes the row count: min(matches, limit). */
export const expectedRows = (expects, limit) => Math.min(expects, limit);

/** Every index named anywhere in a plan (index, index-only and bitmap index scans). */
export function planIndexNames(report) {
  const names = [];
  const walk = (node) => {
    if (node["Index Name"]) names.push(node["Index Name"]);
    for (const child of node.Plans ?? []) walk(child);
  };
  walk(report.Plan);
  return [...new Set(names)];
}

/** True only for an index the experiment created: the base tables' own btrees never count. */
export const ginUsed = (indexNames, experimentIndexes) =>
  indexNames.some((name) => experimentIndexes.includes(name));

/** Planner statistics exist (reltuples is -1 until a table is first vacuumed or analyzed). */
export async function assertAnalyzed(db, tables) {
  const { rows } = await db.query(
    `select t as relname from unnest($1::text[]) t
     left join pg_class c on c.relname = t and c.relnamespace = 'public'::regnamespace
     where c.oid is null or c.reltuples < 0`,
    [tables],
  );
  if (rows.length > 0) throw new Error(`no planner statistics for: ${rows.map((r) => r.relname)}`);
}

/** A notice from ANALYZE or VACUUM saying a table was skipped means statistics are missing. */
export const skippedTables = (notices) => notices.filter((n) => /skipping/i.test(n));

/**
 * Each tenant owns rows carrying a term the other tenant has nowhere. A search for it must find
 * exactly the owner's rows (the control), and every other way of asking, through the other tenant's
 * context, the other tenant's workspace id, or no context, must find nothing. Any row from the wrong
 * tenant is proof of leakage, however the ranking ties.
 */
// fallow-ignore-next-line complexity
export function isolationFailures({ aIds, bIds, aOwn, bOwn, crossings, limit }) {
  const failures = [];
  if (aOwn.length !== Math.min(aIds.size, limit) || bOwn.length !== Math.min(bIds.size, limit)) {
    failures.push("a control search did not find its tenant's marked rows");
  }
  if (aOwn.some((row) => !aIds.has(row.chunkId))) failures.push("tenant A control left A");
  if (bOwn.some((row) => !bIds.has(row.chunkId))) failures.push("tenant B control left B");
  for (const [label, rows] of Object.entries(crossings)) {
    if (rows.length > 0) failures.push(`${label} returned ${rows.length} rows`);
  }
  return failures;
}

/** A finished variant whose results cannot be trusted; the run stops and reports it. */
export class CheckFailure extends Error {}

/** What a finished variant got wrong: row count, rows unlike the baseline's, or a tenant leak. */
export function variantFailures({ key, cases, isolation }) {
  const failures = [];
  for (const c of cases) {
    if (c.countOk !== true) failures.push(`${key}/${c.key}: unexpected row count`);
    if (c.sameAsBaseline?.identical !== true)
      failures.push(`${key}/${c.key}: rows differ from baseline`);
  }
  if (isolation?.passed !== true) failures.push(`${key}: tenant isolation failed`);
  return failures;
}
