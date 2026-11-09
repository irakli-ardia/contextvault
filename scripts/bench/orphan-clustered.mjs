#!/usr/bin/env node
// Slice 5 clustered-backlog benchmark: does the production orphan-discovery page stay bounded when
// live-outbox and cooldown candidates are concentrated in one region of (updated_at, id) order?
// Usage: node scripts/bench/orphan-clustered.mjs   (no environment, no URLs; --smoke for a dry run).
// Same disposable PostgreSQL 18 container, roles and cleanup as orphan-discovery.mjs (orphan-env.mjs);
// the worker role measures post-VACUUM only. Nothing in the project schema or application changes.
// Writes benchmarks/orphan-discovery/clustered-{results,plans}.json and clustered-report.md.

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  classify,
  committedRange,
  compareCounts,
  extractAccounting,
  grade,
  headLimit,
  isNoisy,
  planShape,
  reconcile,
  TARGETS,
} from "./orphan-clustered-checks.mjs";
import { prepare, validateWindows } from "./orphan-clustered-db.mjs";
import {
  CONFIGS,
  datasets,
  expectedCounts,
  inMatrix,
  scenariosOf,
} from "./orphan-clustered-plan.mjs";
import { environmentOf } from "./orphan-discovery.mjs";
import { containersNamed, danglingVolumes, migrate, startBench } from "./orphan-env.mjs";
import { estimateOf, explainDiscovery, loadProduction, measure } from "./orphan-explain.mjs";
import { renderClustered } from "./orphan-report.mjs";
import { countScenarios, seed } from "./orphan-seed.mjs";
import { setVariant, VARIANTS } from "./orphan-steps.mjs";

const SMOKE = process.argv.includes("--smoke");
const WAITING = SMOKE ? 5000 : 200_000;
const PAGE = SMOKE ? 50 : 500;
const DEADLINE_MS = 60 * 60 * 1000;
const WAL_LIMIT_BYTES = 1024 ** 3; // the container's tmpfs is 2 GB
const log = (...args) => console.error(new Date().toISOString().slice(11, 19), ...args);
const variantOf = (config) => VARIANTS.find((v) => v.key === config.variant);

// Raw EXPLAIN is kept for every C3 run, one deep entry per dataset for the other configs, and any
// invalid run or run with a failing plan shape. A non-comparable shape alone is expected for the
// reduced configs and is not a reason to keep the plan.
const keepsPlan = (entry, dataset, config) => {
  const deep = dataset.clusters.length ? `${dataset.clusters.at(-1).name}-entry` : "mid-50";
  const unexpected = entry.invalid || entry.shape.fail.length > 0;
  return config.label === "C3" || entry.scenario === deep || unexpected;
};

export function entryOf(run, base, oracle) {
  const s = run.summary;
  const accounting = extractAccounting(run.plan);
  const mismatches = reconcile(accounting, oracle);
  return {
    ...base,
    ...{ runsMs: run.runs, medianMs: s.executionMs, planningMs: s.planningMs },
    ...{ sharedHit: s.sharedHit, sharedRead: s.sharedRead ?? 0, jit: Boolean(run.plan.JIT) },
    ...{ usPerCandidate: (s.executionMs * 1000) / oracle.q, nodes: estimateOf(run.plan).nodes },
    ...{ accounting, oracle, mismatches, invalid: mismatches.length > 0 },
    shape: planShape(run.plan),
  };
}

// One measured run (warm-up + 3 timed). Noisy runs, and C3 runs within 20% over their P3 budget,
// are repeated once and the repeat decides; the earlier median is kept.
// fallow-ignore-next-line complexity
async function measureEntry(ctx, dataset, config, sc) {
  const { prod, worker, plans } = ctx;
  const id = `${dataset.key}/${config.label}/${sc.key}`;
  const once = () => measure(() => explainDiscovery(prod, worker, PAGE, sc.after));
  const budget = headLimit({ dataset: dataset.key });
  const near = (r) =>
    config.label === "C3" && sc.complete && grade(r.summary.executionMs, budget) === "NEAR";
  const base = { dataset: dataset.key, scenario: sc.key, config: config.label };
  Object.assign(base, { variant: config.variant, complete: sc.complete, q: sc.oracle.q });
  let run = await once();
  if (run.status === "ok" && (isNoisy(run.runs) || near(run))) {
    base.earlier = { runsMs: run.runs, medianMs: run.summary.executionMs };
    run = await once();
  }
  if (run.status !== "ok") {
    const estimate = estimateOf(await explainDiscovery(prod, worker, PAGE, sc.after, true));
    plans[id] = { evidence: "timeout: planner estimate only, not executed", estimate };
    return { ...base, status: run.status, estimate };
  }
  const entry = { ...entryOf(run, base, sc.oracle), status: "ok" };
  if (keepsPlan(entry, dataset, config)) {
    const acc = entry.accounting;
    const evidence = acc.comparable ? "comparable" : `not comparable: ${acc.reason}`;
    plans[id] = { evidence, plan: run.plan };
  }
  return entry;
}

async function guardWal(admin) {
  await admin.query("checkpoint");
  const wal = await admin.query(
    "select coalesce(sum(size), 0)::bigint as bytes from pg_ls_waldir()",
  );
  if (Number(wal.rows[0].bytes) > WAL_LIMIT_BYTES)
    throw new Error("WAL on tmpfs above 1 GB: abort");
}

// fallow-ignore-next-line complexity
async function runDataset(ctx, dataset) {
  const { admin, owner } = ctx;
  await seed(admin, WAITING, dataset.clusters);
  for (const table of ["documents", "document_versions", "outbox"]) {
    await owner.query(`vacuum (analyze) ${table}`);
  }
  await guardWal(admin);
  const counts = await countScenarios(admin);
  const sizes = await admin.query(
    `select sum(pg_total_relation_size(t::regclass))::bigint as bytes
     from unnest(array['documents', 'document_versions', 'outbox']) t`,
  );
  const info = {
    key: dataset.key,
    clusters: dataset.clusters,
    counts,
    sizeBytes: Number(sizes.rows[0].bytes),
  };
  info.countProblems = compareCounts(expectedCounts(WAITING, dataset.clusters), counts);
  await setVariant(ctx.owner, variantOf(CONFIGS.at(-1)));
  info.windows = await validateWindows(admin, dataset.clusters);
  const scenarios = [];
  for (const sc of scenariosOf(dataset, WAITING, PAGE))
    scenarios.push(await prepare(ctx, dataset, sc, PAGE));
  info.scenarios = scenarios.map(({ key, at, complete, oracle, problems }) => ({
    key,
    at,
    complete,
    oracle,
    problems,
  }));
  for (const config of CONFIGS) {
    await setVariant(ctx.owner, variantOf(config));
    for (const sc of scenarios.filter((s) => !s.problems.length && inMatrix(config, dataset, s))) {
      const entry = await measureEntry(ctx, dataset, config, sc);
      ctx.entries.push(entry);
      log(dataset.key, config.label, sc.key, entry.status, entry.medianMs?.toFixed(1));
    }
  }
  info.recountProblems = compareCounts(counts, await countScenarios(admin));
  info.problems = [
    ...info.countProblems,
    ...info.recountProblems,
    ...info.windows.flatMap((w) => w.problems),
    ...info.scenarios.flatMap((s) => s.problems.map((p) => `${s.key}: ${p}`)),
  ];
  return info;
}

async function finish(result) {
  const original = new URL("../../benchmarks/orphan-discovery/results.json", import.meta.url);
  const committed = committedRange(JSON.parse(readFileSync(original, "utf8")));
  result.verdicts = classify(result.entries, committed);
  if (result.datasets.some((d) => d.problems.length)) result.verdicts.overall = "INVALID";
  result.completedAt = new Date().toISOString();
}

async function benchmark(bench, result, plans) {
  await bench.bootstrap();
  result.migrations = await migrate(bench);
  const clients = {};
  try {
    for (const role of ["postgres", "owner", "worker"]) clients[role] = await bench.connect(role);
    const { postgres: admin, owner, worker } = clients;
    const prod = await loadProduction();
    const ctx = { prod, admin, owner, worker, plans, entries: result.entries };
    await admin.query("set statement_timeout = 60000");
    result.environment = await environmentOf(bench, { admin, worker });
    for (const dataset of datasets(WAITING)) result.datasets.push(await runDataset(ctx, dataset));
    await finish(result);
  } finally {
    await Promise.all(Object.values(clients).map((client) => client.end()));
  }
}

const cleanupOf = async (bench, dirtyBefore) => ({
  containerGone: containersNamed(bench.info.name).length === 0,
  newDanglingVolumes: danglingVolumes().filter((v) => !dirtyBefore.includes(v)),
});

function write(result, plans) {
  const folder = `../../benchmarks/orphan-discovery${SMOKE ? "-smoke" : ""}/`;
  const dir = new URL(folder, import.meta.url);
  mkdirSync(dir, { recursive: true });
  // JSON first: a failing report renderer must not lose the measurements, and it fails the process.
  writeFileSync(new URL("clustered-results.json", dir), `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(new URL("clustered-plans.json", dir), `${JSON.stringify(plans)}\n`);
  writeFileSync(new URL("clustered-report.md", dir), renderClustered(result));
}

export async function main() {
  const lingering = containersNamed("cv-bench-orphan");
  if (lingering.length > 0) throw new Error(`refusing to start: ${lingering.join(", ")} exists`);
  const dirtyBefore = danglingVolumes();
  const bench = startBench();
  // Best effort only: it fires while the event loop is free, so it cannot interrupt a synchronous
  // docker call or a statement without its own timeout (the owner session has none). The exit and
  // signal handlers in startBench() and the finally below are what remove the container.
  const deadline = setTimeout(() => {
    log("wall-clock deadline: removing the container");
    bench.stop();
    process.exit(124);
  }, DEADLINE_MS);
  deadline.unref();
  const result = {
    startedAt: new Date().toISOString(),
    smoke: SMOKE,
    page: PAGE,
    waiting: WAITING,
  };
  Object.assign(result, { targets: TARGETS, datasets: [], entries: [] });
  const plans = {};
  try {
    log("starting container", bench.info.name);
    await benchmark(bench, result, plans);
  } finally {
    clearTimeout(deadline);
    bench.stop();
  }
  result.cleanup = await cleanupOf(bench, dirtyBefore);
  write(result, plans);
  log("done", result.verdicts?.overall, result.cleanup);
}

// Both sides through realpath: a relative or symlinked invocation must still run main, an import must not.
const direct =
  process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (direct) await main();
