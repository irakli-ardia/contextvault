// The measured part of a run: environment isolation, identity checks, then every scenario in order.
// Everything is written into `state` as it happens, so a failure keeps what was already measured.

import { createRequire } from "node:module";
import { join } from "node:path";
import { assertIsolated, isolateEnv } from "./ingestion-bench-guards.mjs";
import { compareConcurrency, scenarios } from "./ingestion-bench-plan.mjs";
import { createContext, runScenario } from "./ingestion-bench-run.mjs";
import { environment } from "./retrieval-env.mjs";

const root = new URL("../../", import.meta.url).pathname;
const requireWorker = createRequire(join(root, "apps/worker/package.json"));
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);

const CHECKS = [
  "loopback endpoints",
  "non-development ports",
  "database marker (both roles)",
  "worker role privileges",
  "redis marker and key count",
  "foreign environment dropped",
];

/** Runs every scenario in its own harness (a workspace holds at most 50 documents). */
async function runAll({ list, shared, state, harnesses }) {
  for (const s of list) {
    const h = await shared.lib.createIngestionHarness();
    harnesses.push(h);
    const ctx = createContext({ ...shared, h });
    log("scenario", s.name, `${s.docs.length} docs, concurrency ${s.concurrency}`);
    state.currentScenario = s.name;
    const result = await runScenario(ctx, { ...s, workspaceId: h.wsA });
    ctx.probe.restore();
    const saturated = result.load.saturated.join(",") || "unsaturated";
    log(
      " ",
      s.name,
      `${Math.round(result.wallMs)} ms`,
      `${result.completed}/${result.jobs} completed`,
      saturated,
    );
    if (!s.discard) state.scenarios.push(result);
  }
  state.currentScenario = null;
}

const orderOf = (list) =>
  list.map((s, i) => ({
    order: i + 1,
    name: s.name,
    concurrency: s.concurrency,
    documents: s.docs.length,
    group: s.group ?? null,
    round: s.round ?? null,
    position: s.position ?? null,
    discarded: s.discard === true,
  }));

export async function measure({ docker, pg, bundle, redisPort, urls, marker, opts, state }) {
  const worker = new URL(urls.app);
  worker.username = "contextvault_worker";
  worker.password = pg.secrets.POSTGRES_WORKER_PASSWORD;
  const redisUrl = `redis://127.0.0.1:${redisPort}`;
  // biome-ignore lint/style/noProcessEnv: pointing the config loaders at the disposable stack
  state.droppedEnvironmentVariables = isolateEnv(process.env, {
    NODE_ENV: "test",
    DATABASE_URL: urls.app,
    DATABASE_WORKER_URL: worker.toString(),
    DATABASE_FIXTURE_URL: urls.fixture,
  }).length;
  const pgClient = requireWorker("pg").Client;
  const connection = new (requireWorker("ioredis").Redis)(redisUrl, { maxRetriesPerRequest: null });
  const [fixture, workerRole] = [urls.fixture, worker.toString()].map(
    (u) => new pgClient({ connectionString: u }),
  );
  const harnesses = [];
  try {
    await Promise.all([fixture.connect(), workerRole.connect()]);
    // Before the production code is imported or any harness exists: identity of every endpoint.
    const checked = { ...urls, worker: worker.toString() };
    await assertIsolated({
      urls: checked,
      marker,
      fixture,
      workerRole,
      redis: connection,
      redisUrl,
    });
    state.isolation = { verified: true, checks: CHECKS };
    state.environment = await environment(fixture, workerRole, {
      runs: opts.repeats,
      smoke: opts.smoke,
    });
    const lib = await import(bundle.entry);
    const list = scenarios({ ...opts, inputLimit: lib.parseLimits.maxInputBytes });
    state.scenarioOrder = orderOf(list);
    const shared = {
      lib,
      redis: connection,
      redisUrl,
      parseChild: bundle.parseChild,
      docker,
      postgres: pg.name,
      postgresCpuLimit: state.containers.postgres.cpuLimit,
      pgClient,
    };
    await runAll({ list, shared, state, harnesses });
    state.comparison = compareConcurrency(state.scenarios);
  } finally {
    await Promise.all([fixture.end(), workerRole.end()]);
    for (const h of harnesses) await h.close();
    connection.disconnect();
  }
}
