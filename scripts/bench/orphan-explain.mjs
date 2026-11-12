// Runs the production statements under EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON) and
// reduces each plan to the facts the benchmark reports. The SQL is never written out here:
// `createOrphanSource` and `createOrphanRepository` are the production factories (bundled from
// packages/db/src by the repo's tsdown), and the shim below only renders their drizzle statement
// to text, puts EXPLAIN in front and hands it to a pg client.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("../../", import.meta.url).pathname;
const ANALYZE = "explain (analyze, buffers, settings, format json) ";
const ESTIMATE = "explain (settings, format json) ";

/**
 * Bundles and imports the production factories. The bundle directory is removed before returning
 * or throwing: the import has evaluated the whole module graph by then, so nothing reads it later.
 * `tmp` and `tsdown` are overridable for the cleanup test only.
 */
export async function loadProduction({
  tmp = tmpdir(),
  tsdown = join(root, "packages/db/node_modules/.bin/tsdown"),
  name = "orphan-sql",
} = {}) {
  const out = mkdtempSync(join(tmp, "cv-bench-bundle-"));
  try {
    const build = spawnSync(
      tsdown,
      ["-c", join(root, `scripts/bench/${name}.tsdown.config.mjs`), "-d", out, "-l", "warn"],
      { cwd: join(root, "packages/db"), encoding: "utf8" },
    );
    if (build.status !== 0) {
      throw new Error(`bundle failed: ${(build.stderr || String(build.error)).slice(0, 300)}`);
    }
    const lib = await import(join(out, `${name}.entry.mjs`));
    return { ...lib, dialect: new lib.PgDialect() };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** `real` runs the statement; `explain` collects its plan and returns what the caller needs next. */
export function executor(
  prod,
  client,
  { explain = false, estimate = false, plans = [], lockedRow } = {},
) {
  return {
    // fallow-ignore-next-line complexity
    async execute(statement) {
      const { sql, params } = prod.dialect.sqlToQuery(statement);
      if (!explain) return client.query(sql, params);
      const { rows } = await client.query((estimate ? ESTIMATE : ANALYZE) + sql, params);
      plans.push(rows[0]["QUERY PLAN"][0]);
      return { rows: plans.length === 1 && lockedRow ? [lockedRow] : [] };
    },
  };
}

export async function explainDiscovery(prod, client, limit, after, estimate = false) {
  const plans = [];
  const exec = executor(prod, client, { explain: true, estimate, plans });
  await prod.createOrphanSource(exec).listWaiting(limit, after);
  return plans[0];
}

/** Planner estimate only (no execution): what a statement that timed out was going to do. */
export function estimateOf(report) {
  return {
    totalCost: report.Plan["Total Cost"],
    estimatedRows: report.Plan["Plan Rows"],
    nodes: [...nodes(report.Plan)].map((n) =>
      [n["Node Type"], n["Relation Name"], n["Index Name"]].filter(Boolean).join(" "),
    ),
  };
}

/** Both statements of `lockOrphan`, inside the caller's open transaction. */
export async function explainLock(prod, client, workspaceId, versionId) {
  const plans = [];
  const lockedRow = { status: "queued", attempt: 0 };
  const exec = executor(prod, client, { explain: true, plans, lockedRow });
  await prod.createOrphanRepository(exec, workspaceId).lockOrphan({ versionId, historyCap: 11 });
  return plans;
}

const total = (node, key) => (node[key] ?? 0) * (node["Actual Loops"] ?? 1);

function* nodes(node) {
  yield node;
  for (const child of node.Plans ?? []) yield* nodes(child);
}

/** Planning and execution time, I/O, sorts, scans (with loop counts) and heap fetches. */
export function summarize(report) {
  const root = report.Plan;
  const all = [...nodes(root)];
  const scans = all
    .filter((n) => /Scan$/.test(n["Node Type"]))
    .map((n) => ({
      type: n["Node Type"],
      relation: n["Relation Name"],
      index: n["Index Name"],
      indexCond: n["Index Cond"],
      filter: n.Filter,
      loops: n["Actual Loops"],
      rows: total(n, "Actual Rows"),
      removedByFilter: total(n, "Rows Removed by Filter"),
      heapFetches: n["Heap Fetches"],
      sharedHit: n["Shared Hit Blocks"],
      sharedRead: n["Shared Read Blocks"],
    }));
  return {
    planningMs: report["Planning Time"],
    executionMs: report["Execution Time"],
    rowsReturned: root["Actual Rows"],
    sharedHit: root["Shared Hit Blocks"],
    sharedRead: root["Shared Read Blocks"],
    ioReadMs: root["Shared I/O Read Time"] ?? 0,
    settings: report.Settings ?? {},
    sorts: all
      .filter((n) => n["Node Type"] === "Sort" || n["Node Type"] === "Incremental Sort")
      .map((n) => ({
        key: n["Sort Key"],
        method: n["Sort Method"],
        spaceKb: n["Sort Space Used"],
        rows: n["Actual Rows"],
      })),
    gather: all
      .filter((n) => n["Node Type"].startsWith("Gather"))
      .map((n) => ({ planned: n["Workers Planned"], launched: n["Workers Launched"] })),
    // Aggregates re-run per outer row: the per-document outbox history lookup.
    lateral: all
      .filter((n) => n["Node Type"] === "Aggregate" && n["Actual Loops"] > 1)
      .map((n) => ({
        loops: n["Actual Loops"],
        child: (n.Plans ?? []).map(
          (c) => `${c["Node Type"]}${c["Index Name"] ? ` ${c["Index Name"]}` : ""}`,
        ),
      })),
    scans,
  };
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/**
 * Warm-up, then up to `runs` timed executions; a slow statement (warm-up over 5 s) is timed once.
 * Returns the summary of the median-time run, all times, and the full plan. Timeouts are results.
 */
// fallow-ignore-next-line complexity
export async function measure(explainOnce, runs = 3) {
  const attempt = async () => {
    try {
      return { plan: await explainOnce() };
    } catch (error) {
      if (error?.code === "57014") return { timeout: true };
      throw error;
    }
  };
  const warm = await attempt();
  if (warm.timeout) return { status: "timeout" };
  const timed = [warm.plan];
  if (warm.plan["Execution Time"] <= 5000) {
    for (let run = 0; run < runs; run += 1) {
      const next = await attempt();
      if (next.timeout) return { status: "timeout" };
      timed.push(next.plan);
    }
    timed.shift();
  }
  const times = timed.map((p) => p["Execution Time"]);
  const mid = timed.find((p) => p["Execution Time"] === median(times));
  return { status: "ok", runs: times, summary: summarize(mid), plan: mid };
}
