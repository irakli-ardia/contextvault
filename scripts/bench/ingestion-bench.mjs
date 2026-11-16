#!/usr/bin/env node

// Ingestion benchmark on throwaway PostgreSQL and Redis containers: the production worker consumer,
// stages and activation transaction, offline adapters only (hash embedder, in-memory object store).
//
//   node scripts/bench/ingestion-bench.mjs [plan]       prints what `run` would do; starts nothing
//   node scripts/bench/ingestion-bench.mjs run --execute [--smoke] [--repeats=5] [--rounds=3] [--out=<file.json>]
//   node scripts/bench/ingestion-bench.mjs cleanup      removes leftover ingestion benchmark containers
//
// It starts its own containers (own labels and run id, credentials, loopback-only ports, anonymous
// storage), applies the repository's role scripts and migrations, proves by marker that both the
// database and Redis it connects to are those containers, and removes only them at the end or on a
// signal. It reads no environment file, drops every connection variable from its environment and
// never connects to the development or cv-test stacks. The result file is written once and never
// replaces another file.

import { mkdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs, resolveOutput } from "./ingestion-bench-args.mjs";
import { MIX } from "./ingestion-bench-corpus.mjs";
import {
  buildBundles,
  INGESTION,
  newRunId,
  redisSpec,
  removePostgres,
  removeRedis,
  removeRedisLeftovers,
  startRedis,
} from "./ingestion-bench-infra.mjs";
import { measure } from "./ingestion-bench-measure.mjs";
import { LIMITATIONS, limitationsFor, measurementsFor } from "./ingestion-bench-notes.mjs";
import { classesOf, LEVELS, plan } from "./ingestion-bench-plan.mjs";
import {
  containerFacts,
  explicitArgs,
  gitProvenance,
  leaks,
  newExperimentId,
  sanitizeText,
} from "./ingestion-bench-provenance.mjs";
import { SERVER_ARGS } from "./ingestion-bench-server-stats.mjs";
import { assertCreatable, writeOnce } from "./keyword-experiment-args.mjs";
import {
  containerSpec,
  dockerCli,
  dockerEnvironment,
  removeLeftovers,
} from "./keyword-experiment-container.mjs";
import { assertLocalDocker, installSignalCleanup } from "./keyword-experiment-guards.mjs";
import { prepare } from "./keyword-experiment-run.mjs";

const root = new URL("../../", import.meta.url).pathname;
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);

export { LIMITATIONS, plan };

function configuration(opts) {
  return {
    smoke: opts.smoke,
    repeats: opts.repeats,
    rounds: opts.rounds,
    concurrencyLevels: LEVELS,
    documentCharsByClass: classesOf(opts.smoke),
    workspaceMix: MIX,
    discardedWarmups: 1,
    outputFile: opts.out === undefined ? "default" : basename(opts.out),
    // Present only when asked for, so a run without the flag records exactly what it always did.
    ...(opts.serverStats ? { serverStats: true } : {}),
  };
}

function newState({ experimentId, runId, opts, argv }) {
  return {
    benchmark: "ingestion",
    experimentId,
    runId,
    status: "started",
    startedAt: new Date().toISOString(),
    cli: { command: "run", arguments: explicitArgs(argv) },
    config: configuration(opts),
    ...gitProvenance(),
    containers: {},
    limitations: limitationsFor(opts.serverStats),
    measurements: measurementsFor(opts.serverStats),
    plan: plan(opts),
    scenarios: [],
  };
}

/** Serializes the result, refusing to write anything that holds a secret, a URL or a private path. */
function serialize(state, secrets) {
  const text = `${JSON.stringify(state, null, 2)}\n`;
  const found = leaks(text, secrets);
  if (found.length === 0) return text;
  process.exitCode = 1;
  const refused = `refused: result held ${found.join(", ")}`;
  return `${JSON.stringify({ benchmark: "ingestion", experimentId: state.experimentId, status: refused })}\n`;
}

function conclude(state) {
  const bad = state.scenarios.filter((s) => !s.verification.ok);
  state.status = bad.length === 0 ? "complete" : "invalid";
  if (bad.length > 0)
    state.error = `row-count verification failed in: ${bad.map((s) => s.name).join(", ")}`;
}

const STAGES = { buildBundles, prepare, startRedis, measure, removePostgres, removeRedis };

/** Everything decided before a container exists: a refusal here leaves nothing to clean up. */
function preflight(opts, argv, docker) {
  assertLocalDocker({ docker, env: dockerEnvironment() });
  const out = resolveOutput(opts);
  if (opts.out === undefined) mkdirSync(join(root, "benchmarks/ingestion"), { recursive: true });
  assertCreatable(out);
  const runId = newRunId();
  const experimentId = newExperimentId();
  const serverArgs = opts.serverStats ? SERVER_ARGS : [];
  const pg = containerSpec({ profile: INGESTION, id: runId, serverArgs });
  return {
    out,
    pg,
    redis: redisSpec({ id: runId }),
    marker: `ingbench-${experimentId}`,
    secrets: Object.values(pg.secrets),
    state: newState({ experimentId, runId, opts, argv }),
    bundle: undefined,
  };
}

/** Removes exactly this run's containers (own names and labels) and its bundle, never anything else. */
function teardown(run, docker, stages) {
  const { state, pg, redis } = run;
  try {
    state.cleanup = {
      postgres: stages.removePostgres(docker, pg),
      redis: stages.removeRedis(docker, redis),
    };
    state.cleanup.verified = state.cleanup.postgres.removed && state.cleanup.redis.removed;
  } finally {
    if (run.bundle) rmSync(run.bundle.dir, { recursive: true, force: true });
  }
}

async function provisionAndMeasure(run, { docker, opts }, stages) {
  const { state, pg, redis, marker } = run;
  run.bundle = stages.buildBundles(state.runId);
  const prepared = await stages.prepare(docker, pg, marker);
  state.containers.postgres = containerFacts(prepared.inspect, pg.image);
  const started = await stages.startRedis(docker, redis, marker);
  state.containers.redis = containerFacts(started.inspect, redis.image);
  const urls = prepared.urls;
  await stages.measure({
    docker,
    pg,
    bundle: run.bundle,
    redisPort: started.port,
    urls,
    accepted: prepared.inspect,
    marker,
    opts,
    state,
  });
  conclude(state);
}

function recordFailure({ state, secrets }, error) {
  state.status = "failed";
  state.failedDuring = state.currentScenario ?? "setup";
  state.error = sanitizeText(error?.message ?? error, secrets).slice(0, 300);
}

function publish(run) {
  const { state, out, secrets } = run;
  state.completedAt = new Date().toISOString();
  if (state.status !== "complete" || !state.cleanup.verified) process.exitCode = 1;
  writeOnce(out, serialize(state, secrets));
  log("wrote", basename(out), state.status, JSON.stringify(state.cleanup));
}

/**
 * Tears down and publishes exactly once, from the signal handler or the normal end, whichever comes
 * first. A teardown that throws is recorded as unverified cleanup and the result is still written.
 */
function finalize(run, docker, stages) {
  if (run.finalized) return;
  run.finalized = true;
  try {
    teardown(run, docker, stages);
  } catch (error) {
    run.state.cleanup = {
      verified: false,
      error: sanitizeText(error?.message ?? error, run.secrets).slice(0, 300),
    };
  }
  publish(run);
}

// Needs Docker in earnest; `stages` and `proc` are the seams the unit tests use to drive the
// lifecycle and the signal path without Docker or a real process exit.
export async function run(opts, argv = [], docker = dockerCli, stages = STAGES, proc = process) {
  const current = preflight(opts, argv, docker);
  const removeHandlers = installSignalCleanup(() => {
    current.state.status = "interrupted";
    current.state.interruptedDuring = current.state.currentScenario ?? "setup";
    finalize(current, docker, stages);
  }, proc);
  try {
    await provisionAndMeasure(current, { docker, opts }, stages);
  } catch (error) {
    recordFailure(current, error);
  } finally {
    removeHandlers();
    finalize(current, docker, stages);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  if (opts.command === "cleanup") {
    const postgres = removeLeftovers(dockerCli, INGESTION);
    const redis = removeRedisLeftovers(dockerCli);
    log(JSON.stringify(postgres), JSON.stringify(redis));
    if (postgres.failed.length > 0 || redis.some((r) => !r.removed)) process.exitCode = 1;
  } else if (opts.command === "run" && opts.execute) {
    await run(opts, argv);
  } else {
    console.log(
      plan(opts)
        .map((l) => `- ${l}`)
        .join("\n"),
    );
    console.log("\nrun with: run --execute");
  }
}
