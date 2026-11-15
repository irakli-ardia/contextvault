// Measurements of one variant: plans and timings of the production keyword statement as the
// application role, the same plan as an RLS-exempt role (to explain planner behaviour only), the
// rows it returns, storage, build and insert cost, and tenant isolation.

import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  compareRows,
  expectedRows,
  ginUsed,
  isolationFailures,
  planIndexNames,
} from "./keyword-experiment-checks.mjs";
import { clocked, nearestToMedian, sample, sampleSummary } from "./keyword-experiment-sampling.mjs";
import { RESET } from "./keyword-experiment-variants.mjs";
import { summarize } from "./orphan-explain.mjs";
import { inTenant } from "./retrieval-bench.mjs";
import { stats } from "./retrieval-timing.mjs";

export const POOL = 50; // rrfPoolSize: the limit hybrid search asks of the keyword signal
const PREFIX = {
  run: "",
  analyze: "explain (analyze, buffers, settings, format json) ",
  estimate: "explain (settings, format json) ",
};
const LONG = "set local statement_timeout = '300s'"; // correctness is not a timing question

/** Renders the production statement, applies the variant's rewrite, optionally under EXPLAIN. */
export function variantExecutor(prod, client, variant, { mode = "run", plans = [] } = {}) {
  return {
    async execute(statement) {
      const { sql, params } = prod.dialect.sqlToQuery(statement);
      const { rows } = await client.query(PREFIX[mode] + variant.rewrite(sql), params);
      if (mode === "run") return { rows };
      plans.push(rows[0]["QUERY PLAN"][0]);
      return { rows: [] };
    },
  };
}

const digest = (rows) =>
  createHash("sha256")
    .update(rows.map((r) => `${r.chunkId}:${r.score}`).join("\n"))
    .digest("hex");

/** The statement run under `mode` as `client`, inside tenant `t`; returns the collected plan. */
async function explainOnce(env, client, t, c, mode) {
  const { prod, variant } = env;
  const plans = [];
  const repo = prod.createSearchRepository(variantExecutor(prod, client, variant, { mode, plans }));
  await inTenant(client, t.workspace, t.user, () =>
    repo.keyword({ workspaceId: t.workspace, query: c.query, limit: POOL }),
  );
  return plans[0];
}

/** Whether the executed plan was JIT-compiled, and what that cost (EXPLAIN reports it only then). */
export const jitOf = (plan) =>
  plan.JIT
    ? { used: true, functions: plan.JIT.Functions, totalMs: plan.JIT.Timing?.Total }
    : { used: false };

/**
 * EXPLAIN ANALYZE samples as `client`. When even the warm-up times out there is no executed plan,
 * so the planner's estimate-only plan is recorded and labelled as such.
 */
async function planOf(env, client, c, runs) {
  const explained = async () => {
    const plan = await explainOnce(env, client, env.a, c, "analyze");
    return { ms: plan["Execution Time"], value: plan };
  };
  const sampled = await sample(explained, { runs });
  const executed = sampled.collected > 0;
  const plan = executed
    ? nearestToMedian(sampled)
    : await explainOnce(env, client, env.a, c, "estimate");
  const indexNames = planIndexNames(plan);
  return {
    source: executed ? "analyze" : "estimate",
    ...sampleSummary(sampled),
    summary: executed ? summarize(plan) : undefined,
    jit: executed ? jitOf(plan) : undefined,
    plan,
    indexNames,
    ginUsed: ginUsed(indexNames, env.variant.indexes),
  };
}

/**
 * The rows the statement returns as the application role in tenant `tenant` (null: no context at
 * all), under a timeout long enough that correctness never depends on speed.
 */
export async function searchRows(env, { workspace, tenant, query }) {
  const { prod, app, variant } = env;
  const repo = prod.createSearchRepository(variantExecutor(prod, app, variant));
  const work = async () => {
    await app.query(LONG);
    return repo.keyword({ workspaceId: workspace, query, limit: POOL });
  };
  if (tenant !== null) return inTenant(app, tenant.workspace, tenant.user, work);
  await app.query("begin");
  try {
    return await work();
  } finally {
    await app.query("rollback");
  }
}

export async function measureCase(env, c, reference) {
  const { prod, app, variant, a } = env;
  const rows = await searchRows(env, { workspace: a.workspace, tenant: a, query: c.query });
  const repo = prod.createSearchRepository(variantExecutor(prod, app, variant));
  const timed = () =>
    inTenant(app, a.workspace, a.user, () =>
      repo.keyword({ workspaceId: a.workspace, query: c.query, limit: POOL }),
    );
  return {
    key: c.key,
    query: c.query,
    returned: rows.length,
    countOk: rows.length === expectedRows(c.expects, POOL),
    rowsDigest: digest(rows),
    sameAsBaseline: reference
      ? compareRows(reference, rows)
      : { identical: true, isReference: true },
    appExplain: await planOf(env, app, c, env.runs),
    bypassExplain: await planOf(env, env.fixture, c, 1),
    wall: sampleSummary(await sample(clocked(timed), { runs: env.runs })),
    rows,
  };
}

/**
 * Table, index and (for a stored column) value sizes. `columnBytes` is what the column's values
 * occupy, already included in `table_bytes`: compare it with the baseline's table size, never add it.
 * Row visibility is the reason it is read through `reader`: the owner is subject to forced RLS and
 * would see no rows at all, so the caller passes a role that bypasses it. An empty read is an
 * error, never a zero or null.
 */
export async function storageOf(owner, variant, reader) {
  const { rows } = await owner.query(
    `select pg_table_size('chunks')::bigint as table_bytes, pg_indexes_size('chunks')::bigint as indexes_bytes,
            pg_total_relation_size('chunks')::bigint as total_bytes,
            (select coalesce(sum(pg_relation_size(i::regclass)), 0)::bigint from unnest($1::text[]) i) as new_index_bytes`,
    [variant.indexes],
  );
  if (!variant.column) return { ...rows[0], columnBytes: null };
  const {
    rows: [column],
  } = await reader.query(
    `select count(*)::bigint as rows, sum(pg_column_size(${variant.column}))::bigint as bytes from chunks`,
  );
  if (Number(column.rows) === 0 || column.bytes === null) {
    throw new Error(`no rows to measure ${variant.column}: column size unavailable`);
  }
  return { ...rows[0], columnBytes: column.bytes, columnRows: column.rows };
}

/** Resets the table to its original shape, then times each build statement on its own. */
export async function applyVariant(owner, variant) {
  for (const statement of RESET) await owner.query(statement);
  const buildMs = [];
  for (const statement of variant.build) {
    const start = performance.now();
    await owner.query(statement);
    buildMs.push({ statement: statement.slice(0, 60), ms: performance.now() - start });
  }
  if (variant.column) {
    const { rows } = await owner.query(
      "select has_column_privilege('contextvault_app', 'chunks', $1, 'select') as readable",
      [variant.column],
    );
    if (!rows[0].readable) throw new Error("the application role cannot read the stored column");
  }
  await owner.query("vacuum (analyze) chunks");
  return buildMs;
}

export const INSERT_ROWS = 5000;

/**
 * Cost of inserting existing chunk rows again under a new ordinal, rolled back. Index maintenance
 * and generated-column evaluation are inside the timing; a GIN index defers part of its work to a
 * pending list, so a build time and a later VACUUM are the other half of the picture. The rows
 * actually inserted are counted, and a shortfall (the workspace has fewer chunks than asked for) is
 * an error rather than a smaller workload under the requested label.
 */
export async function insertCost(fixture, workspaceId, rows = INSERT_ROWS, reps = 3) {
  const times = [];
  for (let i = 0; i < reps; i += 1) {
    await fixture.query("begin");
    try {
      const start = performance.now();
      const result = await fixture.query(
        `insert into chunks (id, workspace_id, version_id, section_id, strategy_id, strategy_version,
           ordinal, content, content_sha256, token_count, start_offset, end_offset)
         select gen_random_uuid(), workspace_id, version_id, section_id, strategy_id, strategy_version,
           ordinal + 1000000, content, content_sha256, token_count, start_offset, end_offset
         from chunks where workspace_id = $1 order by id limit $2`,
        [workspaceId, rows],
      );
      times.push(performance.now() - start);
      if (result.rowCount !== rows) {
        throw new Error(`insert cost: ${result.rowCount} rows inserted, ${rows} requested`);
      }
    } finally {
      await fixture.query("rollback");
    }
  }
  const { median, min, max } = stats(times);
  return { requested: rows, rows, samples: times, median, min, max };
}

export async function isolationOf(env) {
  const { a, b } = env;
  const find = (workspace, tenant, query) => searchRows(env, { workspace, tenant, query });
  const failures = isolationFailures({
    aIds: a.ids,
    bIds: b.ids,
    limit: POOL,
    aOwn: await find(a.workspace, a, a.term),
    bOwn: await find(b.workspace, b, b.term),
    crossings: {
      "A context, A workspace, B term": await find(a.workspace, a, b.term),
      "A context, B workspace, B term": await find(b.workspace, a, b.term),
      "B context, B workspace, A term": await find(b.workspace, b, a.term),
      "B context, A workspace, A term": await find(a.workspace, b, a.term),
      "no context, A workspace, A term": await find(a.workspace, null, a.term),
      "no context, B workspace, B term": await find(b.workspace, null, b.term),
    },
  });
  return { passed: failures.length === 0, failures };
}
