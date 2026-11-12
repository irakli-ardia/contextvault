#!/usr/bin/env node
// M2.2e: query plans and latency of the production vector, keyword and hybrid retrieval statements
// over a deterministic synthetic corpus, in the isolated test stack only.
//
//   CV_TEST_ENV_DIR=<dir> node scripts/test-stack/with-test-stack.mjs \
//     node scripts/bench/retrieval-bench.mjs [--smoke] [--sizes=1000,10000] [--out=<dir>]
//
// The wrapper verifies the stack and passes only its URLs; this script refuses to run without it.
// It creates one user and one workspace per size and removes them again. It never alters the
// schema or creates an index.

import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { executor, loadProduction, measure } from "./orphan-explain.mjs";
import { corpusDigest, keywordCases, MODEL, queryVector } from "./retrieval-corpus.mjs";
import { environment } from "./retrieval-env.mjs";
import { assertStackEnv, assertStackIdentity } from "./retrieval-guard.mjs";
import { renderReport } from "./retrieval-report.mjs";
import { createOwner, removeOwner, removeWorkspace, seedWorkspace } from "./retrieval-seed.mjs";
import { settled, wall as timedWall } from "./retrieval-timing.mjs";

const require = createRequire(new URL("../../packages/db/package.json", import.meta.url));
// The driver belongs to packages/db; a variable keeps the root from declaring it.
const driver = "pg";
const { Client, Pool } = require(driver);

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const SMOKE = args.includes("--smoke");
const SIZES = (flag("sizes") ?? (SMOKE ? "500" : "1000,10000,50000")).split(",").map(Number);
const RUNS = SMOKE ? 3 : 7;
const POOL = 50; // rrfPoolSize
const SMALL = 5; // the default search limit
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);

/** One transaction as the unit of work opens it: tenant context, then the callback. */
async function inTenant(client, workspaceId, userId, work) {
  await client.query("begin");
  try {
    await client.query(
      "select set_config('app.user_id', $1, true), set_config('app.workspace_id', $2, true)",
      [userId, workspaceId],
    );
    return await work();
  } finally {
    await client.query("rollback");
  }
}

const wall = (fn, runs = RUNS) => timedWall(fn, runs);

async function explainOf(prod, app, ctx, call) {
  return inTenant(app, ctx.workspaceId, ctx.userId, async () => {
    const plans = [];
    await call(prod.createSearchRepository(executor(prod, app, { explain: true, plans })));
    return plans[0];
  });
}

const entryOf = (m, limit) => ({
  status: m.status,
  runs: m.runs,
  summary: m.summary,
  jitMs: m.plan?.JIT?.Timing?.Total,
  plan: limit === POOL ? m.plan : undefined,
});

const bytesOf = (rows) => rows.reduce((sum, r) => sum + Buffer.byteLength(r.content), 0);

// fallow-ignore-next-line complexity
async function measureSize(prod, app, ctx, size) {
  const { workspaceId, userId } = ctx;
  const repo = prod.createSearchRepository(executor(prod, app));
  const vec = (n) => queryVector(n).slice(1, -1).split(",").map(Number);
  const result = { size, vector: {}, keyword: {}, hybrid: {} };
  const lists = {};

  for (const limit of [SMALL, POOL]) {
    const call = (r) => r.nearest({ workspaceId, model: MODEL, embedding: vec(0), limit });
    const m = await measure(() => explainOf(prod, app, ctx, call), RUNS);
    result.vector[`explain-${limit}`] = entryOf(m, limit);
    result.vector[`wall-${limit}`] = await wall(() =>
      inTenant(app, workspaceId, userId, () => call(repo)),
    );
    lists[`vector-${limit}`] = (
      await settled(() => inTenant(app, workspaceId, userId, () => call(repo)))
    ).rows;
    log(size, "vector", limit, m.summary?.executionMs?.toFixed(1));
  }
  for (const c of keywordCases(size)) {
    result.keyword[c.key] = { query: c.query, expects: c.expects };
    for (const limit of [SMALL, POOL]) {
      const call = (r) => r.keyword({ workspaceId, query: c.query, limit });
      const m = await measure(() => explainOf(prod, app, ctx, call), RUNS);
      // EXPLAIN ANALYZE can finish under the limit while the plain statement does not: both are results.
      const fetched =
        m.status === "ok"
          ? await settled(() => inTenant(app, workspaceId, userId, () => call(repo)))
          : { timeout: true, rows: [] };
      const { rows } = fetched;
      const timedOut = fetched.timeout;
      Object.assign(result.keyword[c.key], {
        [`explain-${limit}`]: entryOf(m, limit),
        [`wall-${limit}`]: timedOut
          ? { timeout: true }
          : await wall(() => inTenant(app, workspaceId, userId, () => call(repo))),
        [`returned-${limit}`]: rows.length,
        [`bytes-${limit}`]: bytesOf(rows),
      });
      lists[`keyword-${c.key}-${limit}`] = rows;
      log(
        size,
        "keyword",
        c.key,
        limit,
        m.summary?.executionMs?.toFixed(1),
        "returned",
        rows.length,
      );
    }
  }
  // Hybrid = both pool-sized statements in one transaction (as searchChunks) plus fusion.
  for (const c of keywordCases(size)) {
    const both = async () => ({
      vector: await repo.nearest({ workspaceId, model: MODEL, embedding: vec(0), limit: POOL }),
      keyword: await repo.keyword({ workspaceId, query: c.query, limit: POOL }),
    });
    const wallHybrid = result.keyword[c.key]["wall-50"].timeout
      ? { timeout: true }
      : await wall(() => inTenant(app, workspaceId, userId, both));
    const input = { vector: lists["vector-50"], keyword: lists[`keyword-${c.key}-50`] };
    const fuseStart = performance.now();
    const reps = 200;
    let fused;
    for (let i = 0; i < reps; i += 1) fused = prod.fuseRrf(input, 20);
    result.hybrid[c.key] = {
      wall: wallHybrid,
      fusionMs: (performance.now() - fuseStart) / reps,
      fusedReturned: fused.length,
      candidates: input.vector.length + input.keyword.length,
      candidateBytes: bytesOf(input.vector) + bytesOf(input.keyword),
      vectorOnlyWall5: result.vector["wall-5"],
    };
  }
  result.transactionOverhead = await wall(
    () => inTenant(app, workspaceId, userId, async () => undefined),
    20,
  );
  result.vectorQueries = await vectorSpread(prod, app, ctx);
  return result;
}

/** The exact cosine scan does not depend on the query vector; three vectors confirm it. */
async function vectorSpread(prod, app, { workspaceId, userId }) {
  const repo = prod.createSearchRepository(executor(prod, app));
  const out = [];
  for (const n of [0, 1, 2]) {
    const embedding = queryVector(n).slice(1, -1).split(",").map(Number);
    out.push(
      (
        await wall(
          () =>
            inTenant(app, workspaceId, userId, () =>
              repo.nearest({ workspaceId, model: MODEL, embedding, limit: POOL }),
            ),
          5,
        )
      ).median,
    );
  }
  return out;
}

// fallow-ignore-next-line complexity
export async function main() {
  const prod = await loadProduction({ name: "retrieval-sql" });
  const fixtureUrl = prod.loadFixtureEnv().DATABASE_FIXTURE_URL;
  const appUrl = prod.loadDatabaseEnv().DATABASE_URL;
  // biome-ignore lint/style/noProcessEnv: the guard re-checks what the stack wrapper verified
  const { CV_TEST_STACK_VERIFIED: verified, CV_TEST_DB_MARKER: marker } = process.env;
  assertStackEnv({ verified, marker, appUrl, fixtureUrl });
  const fixture = new Pool({ connectionString: fixtureUrl, max: 2 });
  await assertStackIdentity(fixture, marker);
  const app = new Client({ connectionString: appUrl });
  await app.connect();
  const result = { startedAt: new Date().toISOString(), sizes: [], digests: {} };
  const userId = await createOwner(fixture);
  try {
    result.environment = await environment(fixture, app, { runs: RUNS, smoke: SMOKE });
    for (const size of SIZES) {
      log("seeding", size);
      result.digests[size] = corpusDigest(size);
      const workspaceId = await seedWorkspace(fixture, userId, size);
      try {
        result.sizes.push(await measureSize(prod, app, { workspaceId, userId }, size));
      } finally {
        await removeWorkspace(fixture, workspaceId);
      }
    }
    result.completedAt = new Date().toISOString();
  } finally {
    await removeOwner(fixture, userId);
    await app.end();
    await fixture.end();
  }
  const dir = flag("out") ?? new URL("../../benchmarks/retrieval/", import.meta.url).pathname;
  if (SMOKE && flag("out") === undefined) {
    console.log(renderReport(result));
    return;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/results.json`, `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(`${dir}/report.md`, renderReport(result));
  log("wrote", dir);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
