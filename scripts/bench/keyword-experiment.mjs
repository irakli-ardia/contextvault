#!/usr/bin/env node

// Keyword-search index experiment on a throwaway PostgreSQL container.
//
//   node scripts/bench/keyword-experiment.mjs [plan] [--chunks=N] [--out=<file.json>]
//                                       prints what `run` would do; starts nothing
//   node scripts/bench/keyword-experiment.mjs run --execute [--chunks=50000] [--out=<file.json>]
//   node scripts/bench/keyword-experiment.mjs cleanup     removes leftover experiment containers
//
// `run` starts its own container (own credentials, anonymous storage, loopback-only port) on a
// local Docker daemon, applies the repository's role scripts and migrations to it, seeds a
// deterministic corpus, measures four alternatives as contextvault_app under forced RLS, and
// always removes the container. It reads no environment file and never connects to the
// development or test stacks. The result file is written once and never replaces another file;
// a run that fails or is interrupted still writes what it measured, labelled `partial`,
// `checks-failed` or `interrupted`, and exits non-zero, as does a result that cannot be written
// (the temporary file is kept and named). A variant that returns a wrong row count, rows unlike the
// baseline's, or any cross-tenant row ends the run as `checks-failed`. Runs of any size other than 50000 chunks need `--out` outside the repository.

import {
  assertCreatable,
  parseArgs,
  provenance,
  resolveOutput,
  writeOnce,
} from "./keyword-experiment-args.mjs";
import { CheckFailure } from "./keyword-experiment-checks.mjs";
import {
  containerSpec,
  dockerCli,
  dockerEnvironment,
  removeContainer,
  removeLeftovers,
} from "./keyword-experiment-container.mjs";
import { assertLocalDocker, installSignalCleanup } from "./keyword-experiment-guards.mjs";
import { experiment, prepare } from "./keyword-experiment-run.mjs";
import { VARIANTS } from "./keyword-experiment-variants.mjs";
import { loadProduction } from "./orphan-explain.mjs";

export const LIMITATIONS = [
  "Slow statements get fewer than the requested samples (see `collected` and `stop`); the warm-up is never counted.",
  "Insert cost is a rolled-back INSERT ... SELECT. GIN defers part of its work to a pending list, so its insert cost is a lower bound; build time is reported separately and the flush on VACUUM is not measured.",
  "The RLS-exempt plan only explains planner behaviour; application-role plans and times decide.",
  "A variant that failed a check (row count, equality with the baseline, tenant isolation) is kept in full with its `failures`, the run is `checks-failed` and later variants are not measured.",
  "A variant that failed or was interrupted is kept with `complete: false` and the cases finished before it stopped; the case in progress, and a build, storage, insert or isolation step that did not finish, are not recorded.",
];

const errorText = (error) => String(error?.message ?? error).slice(0, 300);

const REAL = {
  load: () => loadProduction({ name: "retrieval-sql" }),
  prepare,
  experiment,
  write: writeOnce,
};

async function run(opts, { docker, log, env, engine = REAL }) {
  assertLocalDocker({ docker, env });
  const output = resolveOutput(opts);
  assertCreatable(output);
  const prod = await engine.load(); // before any container exists
  const spec = containerSpec();
  const state = {
    startedAt: new Date().toISOString(),
    image: spec.image,
    chunks: opts.chunks,
    variantsPlanned: VARIANTS.length,
    completion: "partial",
    ...provenance(),
    limitations: LIMITATIONS,
    variants: [],
  };
  let removal;
  let publishError;
  // Idempotent and synchronous, so a signal handler and `finally` can both call it.
  const finish = () => {
    if (removal !== undefined) return removal;
    try {
      removal = removeContainer(docker, spec.name);
    } catch (error) {
      removal = { removed: false, detail: errorText(error) };
    }
    state.containerRemoved = removal.removed;
    if (!removal.removed) {
      state.removalDetail = removal.detail;
      log(
        `container ${spec.name} not removed (${removal.detail}): run "keyword-experiment.mjs cleanup"`,
      );
    }
    state.completedAt = new Date().toISOString();
    try {
      engine.write(output, `${JSON.stringify(state, null, 2)}\n`);
      log("wrote", output);
    } catch (error) {
      publishError = error;
      log("result file not written:", String(error?.message ?? error));
    }
    return removal;
  };
  // Stays installed until `finish` has returned, so a signal cannot kill the process mid-removal.
  const uninstall = installSignalCleanup((signal) => {
    if (removal === undefined) {
      state.completion = "interrupted";
      state.interruptedBy = signal;
    }
    finish();
  });
  let failure;
  try {
    await engine.experiment(await engine.prepare(docker, spec), {
      chunks: opts.chunks,
      prod,
      state,
      log,
    });
    state.completion = "complete";
  } catch (error) {
    state.error = errorText(error);
    if (error instanceof CheckFailure) state.completion = "checks-failed";
    failure = error instanceof Error ? error : new Error(errorText(error));
  } finally {
    try {
      finish(); // removes the container first, so a failed publish cannot leave it running
    } finally {
      uninstall();
    }
  }
  const leftover = removal.removed
    ? undefined
    : new Error(`container ${spec.name} may still exist (${removal.detail}): run cleanup`);
  const errors = [publishError, failure, leftover].filter((error) => error !== undefined);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    const [first, ...rest] = errors;
    const message = [
      errorText(first),
      ...rest.map((error) =>
        error === failure ? `the run also failed: ${errorText(error)}` : errorText(error),
      ),
    ].join("; ");
    throw new AggregateError(errors, message);
  }
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const { docker = dockerCli, log = console.log, env = dockerEnvironment(), engine } = deps;
  const opts = parseArgs(argv);
  if (opts.command === "cleanup") {
    assertLocalDocker({ docker, env });
    const { removed, failed } = removeLeftovers(docker);
    log(`removed: ${removed.join(", ") || "none"}`);
    if (failed.length > 0) throw new Error(`not removed: ${failed.map((f) => f.name).join(", ")}`);
    return;
  }
  if (opts.command === "run" && opts.execute) return run(opts, { docker, log, env, engine });
  const spec = containerSpec();
  log(`docker ${spec.args.join(" ")}`);
  log(`variants: ${VARIANTS.map((v) => v.key).join(", ")}; chunks: ${opts.chunks}`);
  log(`output: ${resolveOutput(opts)}`);
  log(
    opts.command === "run"
      ? "run needs --execute: nothing was started"
      : "plan only: nothing was started",
  );
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
