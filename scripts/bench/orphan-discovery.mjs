#!/usr/bin/env node
// Slice 5 benchmark: the production orphan-discovery and lock statements against candidate indexes,
// in a disposable PostgreSQL 18 container (orphan-env.mjs) that this script creates and removes.
// Usage: node scripts/bench/orphan-discovery.mjs   (no environment, no URLs; --smoke for a tiny dry run).
// Writes benchmarks/orphan-discovery/{results.json,plans.json,report.md}. Nothing in the project
// schema, migrations or application code changes; the experimental indexes exist only in the
// container. Roles: `privileged` is the bootstrap superuser (RLS-exempt, stands for the fixture/
// owner view of every row); `worker` is contextvault_worker with its production limits.

import { mkdirSync, writeFileSync } from "node:fs";
import { containersNamed, danglingVolumes, migrate, startBench } from "./orphan-env.mjs";
import { estimateOf, explainDiscovery, loadProduction, measure } from "./orphan-explain.mjs";
import { renderReport } from "./orphan-report.mjs";
import { countScenarios, seed } from "./orphan-seed.mjs";
import {
  lockSamples,
  measureLock,
  PAGE,
  pickCursors,
  setVariant,
  VARIANTS,
} from "./orphan-steps.mjs";

// --smoke shrinks the data to check the harness itself; its output is not a result.
const SMOKE = process.argv.includes("--smoke");
const WAITING = SMOKE ? 5000 : 200_000;
const LADDER = SMOKE ? [1000] : [2000, 5000, 10_000];
const PRIVILEGED_TIMEOUT_MS = 60_000;
const log = (...args) => console.error(new Date().toISOString().slice(11, 19), ...args);

export async function environmentOf(bench, clients) {
  const { admin, worker } = clients;
  const { rows } = await admin.query(`select name, setting from pg_settings where name in
    ('shared_buffers','work_mem','random_page_cost','effective_cache_size',
     'max_parallel_workers_per_gather','jit','autovacuum','fsync')`);
  return {
    image: bench.info.image,
    host: "127.0.0.1",
    port: bench.info.port,
    systemIdentifier: bench.info.systemIdentifier,
    serverVersionNum: bench.info.serverVersionNum,
    workerStatementTimeout: (await worker.query("show statement_timeout")).rows[0]
      .statement_timeout,
    settings: Object.fromEntries(rows.map((r) => [r.name, r.setting])),
  };
}

// Baseline only, at growing sizes: shows how the unindexed statement scales (extrapolation aid).
async function baselineLadder(prod, { admin, owner }) {
  const ladder = [];
  for (const n of LADDER) {
    await seed(admin, n);
    await owner.query("analyze document_versions; analyze outbox");
    const run = await measure(() => explainDiscovery(prod, admin, PAGE, undefined), 1);
    ladder.push({ waiting: n, status: run.status, executionMs: run.summary?.executionMs });
    log("ladder", n, run.status, run.summary?.executionMs);
  }
  return ladder;
}

async function scenariosOf(prod, admin, dataset) {
  const picked = await pickCursors(prod, admin);
  dataset.eligibleListed = picked.eligible;
  dataset.pages = picked.cursors.length + 1;
  const deep = [0.5, 0.9, 0.99].map((p) => {
    const page = Math.max(1, Math.round(picked.cursors.length * p));
    return {
      key: `depth-${Math.round(p * 100)}`,
      after: picked.cursors[page - 1],
      rowsBefore: page * PAGE,
      depth: (page * PAGE) / picked.eligible,
    };
  });
  return [{ key: "page-1", after: undefined, rowsBefore: 0, depth: 0 }, ...deep];
}

async function runVariant({ prod, phase, variant, roles, scenarios, samples, result, plans }) {
  for (const role of roles) {
    for (const sc of scenarios) {
      const id = `${phase}/${variant.key}/${role.key}/${sc.key}`;
      const run = await measure(() => explainDiscovery(prod, role.client, PAGE, sc.after));
      const entry = {
        phase,
        variant: variant.key,
        role: role.key,
        scenario: sc.key,
        status: run.status,
      };
      if (run.status === "ok") {
        Object.assign(entry, { runsMs: run.runs, summary: run.summary });
        plans[id] = run.plan;
      } else {
        entry.estimate = estimateOf(
          await explainDiscovery(prod, role.client, PAGE, sc.after, true),
        );
      }
      result.runs.push(entry);
      log(id, run.status, run.summary?.executionMs?.toFixed(1));
    }
    const lock = await measureLock(prod, role.client, samples);
    result.lock.push({ phase, variant: variant.key, role: role.key, ...lock });
  }
}

// fallow-ignore-next-line complexity
async function runPhases(ctx, owner, admin) {
  for (const phase of ["pre-vacuum", "post-vacuum"]) {
    if (phase === "post-vacuum") {
      for (const table of ["documents", "document_versions", "outbox"]) {
        await owner.query(`vacuum (analyze) ${table}`);
      }
    }
    const { rows } = await owner.query(
      "select relname, relpages, relallvisible from pg_class where relname in ('outbox', 'document_versions')",
    );
    ctx.result.visibility[phase] = rows;
    await admin.query("checkpoint");
    for (const variant of VARIANTS) {
      ctx.result.variants[`${phase}/${variant.key}`] = await setVariant(owner, variant);
      await runVariant({ ...ctx, phase, variant });
    }
  }
}

async function benchmark(bench, result, plans) {
  await bench.bootstrap();
  result.migrations = await migrate(bench);
  const admin = await bench.connect("postgres");
  const owner = await bench.connect("owner");
  const worker = await bench.connect("worker");
  try {
    const prod = await loadProduction();
    result.environment = await environmentOf(bench, { admin, worker });
    await admin.query(`set statement_timeout = ${PRIVILEGED_TIMEOUT_MS}`);
    result.ladder = await baselineLadder(prod, { admin, owner });

    await seed(admin, WAITING);
    result.dataset = await countScenarios(admin);
    await setVariant(owner, VARIANTS[3]);
    const scenarios = await scenariosOf(prod, admin, result.dataset);
    result.scenarios = scenarios.map(({ key, rowsBefore, depth }) => ({ key, rowsBefore, depth }));
    result.ownerVisibleRows = Number(
      (await owner.query("select count(*) from document_versions")).rows[0].count,
    );
    const ctx = {
      prod,
      scenarios,
      samples: await lockSamples(admin),
      roles: [
        { key: "privileged", client: admin },
        { key: "worker", client: worker },
      ],
      result,
      plans,
    };
    await runPhases(ctx, owner, admin);
    result.completedAt = new Date().toISOString();
  } finally {
    await Promise.all([admin.end(), owner.end(), worker.end()]);
  }
}

export async function main() {
  const dirtyBefore = danglingVolumes();
  const bench = startBench();
  const result = {
    startedAt: new Date().toISOString(),
    runs: [],
    lock: [],
    variants: {},
    visibility: {},
  };
  const plans = {};
  try {
    log("starting container", bench.info.name);
    await benchmark(bench, result, plans);
  } finally {
    bench.stop();
  }
  result.cleanup = {
    containerGone: containersNamed(bench.info.name).length === 0,
    newDanglingVolumes: danglingVolumes().filter((v) => !dirtyBefore.includes(v)),
  };
  const dir = new URL(`../../benchmarks/orphan-discovery${SMOKE ? "-smoke" : ""}/`, import.meta.url)
    .pathname;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}results.json`, `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(`${dir}plans.json`, `${JSON.stringify(plans)}\n`);
  writeFileSync(`${dir}report.md`, renderReport(result));
  log("done", result.cleanup);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
