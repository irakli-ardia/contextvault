// The measured part of the experiment: from a running, verified container to the variants'
// results. Each variant enters `state` before its first step and is filled in as steps finish, so a
// failure or interrupt keeps everything measured so far; `complete` marks a variant that finished.

import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { assertAppRole, CheckFailure, variantFailures } from "./keyword-experiment-checks.mjs";
import {
  assertContainerSafe,
  inspectContainer,
  migrationSql,
  psql,
  startContainer,
  waitReady,
} from "./keyword-experiment-container.mjs";
import {
  applyVariant,
  INSERT_ROWS,
  insertCost,
  isolationOf,
  measureCase,
  storageOf,
} from "./keyword-experiment-measure.mjs";
import {
  analyzeAll,
  collectNotices,
  seedTenants,
  TAGGED,
  TENANT_B_CHUNKS,
} from "./keyword-experiment-seed.mjs";
import { VARIANTS } from "./keyword-experiment-variants.mjs";
import { keywordCases } from "./retrieval-corpus.mjs";
import { assertStackEnv, assertStackIdentity } from "./retrieval-guard.mjs";

const require = createRequire(new URL("../../packages/db/package.json", import.meta.url));
// The driver belongs to packages/db; a variable keeps the root from declaring it.
const driver = "pg";
const { Client } = require(driver);

const CASES = ["rare", "common", "absent"]; // selective, common, absent
const RUNS = 5;
const SETTINGS = [
  "server_version",
  "shared_buffers",
  "effective_cache_size",
  "work_mem",
  "jit",
  "jit_above_cost",
  "random_page_cost",
  "max_parallel_workers_per_gather",
  "default_statistics_target",
  "gin_pending_list_limit",
];
const connect = async (url) => {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
};

/** Starts the container, accepts it only after `docker inspect` passes, and builds the schema. */
export async function prepare(
  docker,
  spec,
  marker = `kwexp-${spec.id}-${randomBytes(6).toString("hex")}`,
) {
  startContainer(docker, spec);
  await waitReady(docker, spec);
  const inspect = inspectContainer(docker, spec);
  const port = assertContainerSafe(inspect, spec);
  psql(docker, spec, "postgres", `comment on database "${spec.database}" is '${marker}'`);
  psql(docker, spec, "contextvault_owner", migrationSql());
  const url = (user, password) =>
    `postgresql://${user}:${password}@127.0.0.1:${port}/${spec.database}`;
  const { secrets } = spec;
  return {
    marker,
    inspect,
    urls: {
      app: url("contextvault_app", secrets.POSTGRES_APP_PASSWORD),
      fixture: url("contextvault_fixture", secrets.POSTGRES_FIXTURE_PASSWORD),
      owner: url("contextvault_owner", secrets.POSTGRES_OWNER_PASSWORD),
    },
  };
}

const STEPS = { applyVariant, insertCost, isolationOf, measureCase, storageOf };

/** Measures one variant into `state.variants`; returns the cases with their rows for comparison. */
export async function measureVariant(env, cases, reference, state, log, steps = STEPS) {
  const { variant, owner, fixture, a, insertRows } = env;
  const entry = { key: variant.key, label: variant.label, complete: false, cases: [] };
  state.variants.push(entry);
  entry.buildMs = await steps.applyVariant(owner, variant);
  const results = [];
  for (const c of cases) {
    results.push(await steps.measureCase(env, c, reference?.[c.key]));
    entry.cases.push({ ...results.at(-1), rows: undefined });
    log(variant.key, c.key, results.at(-1).appExplain.source);
  }
  entry.storage = await steps.storageOf(owner, variant, fixture);
  entry.insert = await steps.insertCost(fixture, a.workspace, insertRows);
  entry.isolation = await steps.isolationOf(env);
  entry.complete = true;
  entry.failures = variantFailures(entry);
  // Fail closed: every measurement stays in `state`, but a wrong or leaking variant ends the run.
  if (entry.failures.length > 0) throw new CheckFailure(entry.failures.join("; "));
  return results;
}

export async function experiment({ urls, marker }, { chunks, prod, state, log }) {
  // The harness itself verified the container; the shared guard re-checks endpoint and identity.
  assertStackEnv({ verified: "1", marker, appUrl: urls.app, fixtureUrl: urls.fixture });
  const [app, fixture, owner] = await Promise.all(
    [urls.app, urls.fixture, urls.owner].map(connect),
  );
  try {
    for (const client of [app, fixture, owner]) await assertStackIdentity(client, marker);
    state.appRole = await assertAppRole(app);
    const warnings = { fixture: collectNotices(fixture), owner: collectNotices(owner) };
    log("seeding", chunks);
    const [a, b] = await seedTenants(fixture, chunks);
    await analyzeAll(owner, warnings.owner);
    // The RLS-exempt role only explains planner behaviour; bound it so it can never run unattended.
    await fixture.query("set statement_timeout = '120s'");
    const { rows } = await fixture.query(
      `select name, setting from pg_settings where name = any($1)`,
      [SETTINGS],
    );
    state.settings = rows;
    // `chunks` in the result is tenant A's size; tenant B is a fixed second tenant for isolation.
    const insertRows = Math.min(INSERT_ROWS, chunks);
    state.corpus = {
      tenantAChunks: chunks,
      tenantBChunks: TENANT_B_CHUNKS,
      totalChunks: chunks + TENANT_B_CHUNKS,
      markedChunksPerTenant: TAGGED,
      insertRows,
    };
    state.warnings = warnings;
    const base = { prod, app, fixture, owner, runs: RUNS, a, b, insertRows };
    const cases = keywordCases(chunks).filter((c) => CASES.includes(c.key));
    let reference;
    for (const variant of VARIANTS) {
      log("variant", variant.key);
      state.currentVariant = variant.key;
      const results = await measureVariant({ ...base, variant }, cases, reference, state, log);
      reference ??= Object.fromEntries(results.map((r) => [r.key, r.rows]));
    }
    state.currentVariant = null;
  } finally {
    await Promise.all([app.end(), fixture.end(), owner.end()]);
  }
}
