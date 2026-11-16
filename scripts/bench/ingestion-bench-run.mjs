// The measured part of the ingestion benchmark: the production consumer, stages and activation run
// against a disposable stack with offline adapters (hash embedder, in-memory object store). It
// only wraps the production objects to time them; no application behaviour is changed.

import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { delta, snapshot } from "./ingestion-bench-db.mjs";
import { saturation, startLoadMeter } from "./ingestion-bench-load.mjs";
import { activations, installProbe } from "./ingestion-bench-probe.mjs";
import { summaries, verifyCounts, versionRows } from "./ingestion-bench-rows.mjs";
import { als, memoryStore, now, tracedStages, tracedUow } from "./ingestion-bench-trace.mjs";

const TIMEOUT_MS = 20 * 60_000;

async function verify(ctx, items) {
  const ids = items.map((i) => i.versionId);
  const { fixture } = ctx.h.fx;
  const { rows: statuses } = await fixture.query(
    `select status, attempt, error_stage, error_code, count(*)::int as versions
     from document_versions where id = any($1) group by 1, 2, 3, 4 order by 1, 2`,
    [ids],
  );
  const { rows: counts } = await fixture.query(
    `select v.id, v.status,
       (select count(*) from chunks c where c.version_id = v.id)::int as chunks,
       (select count(*) from chunk_embeddings e where e.version_id = v.id)::int as embeddings
     from document_versions v where v.id = any($1)`,
    [ids],
  );
  return { statuses, ...verifyCounts(items, counts) };
}

/** Counts ends of jobs from the consumer's own log; only codes and outcomes are kept. */
function jobLog() {
  const kept = [];
  let finished = 0;
  let wake;
  const log = (entry) => {
    const { code, outcome, stage, failure, reason } = entry;
    kept.push({ code, outcome, stage, failure, reason });
    if (["INGESTION_JOB_DONE", "INGESTION_JOB_ERROR", "INGESTION_JOB_REJECTED"].includes(code)) {
      finished += 1;
      wake?.();
    }
  };
  const until = (count) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("scenario timed out")), TIMEOUT_MS);
      wake = () => {
        if (finished >= count) {
          clearTimeout(timer);
          resolve();
        }
      };
      wake();
    });
  return { log, until, kept };
}

export function createContext({
  lib,
  h,
  redis,
  redisUrl,
  parseChild,
  docker,
  postgres,
  postgresCpuLimit,
  pgClient,
}) {
  const probe = installProbe(pgClient, performance, () => als.getStore()?.call);
  return {
    lib,
    h,
    redis,
    redisUrl,
    parseChild,
    docker,
    postgres,
    postgresCpuLimit,
    probe,
    events: [],
    store: memoryStore(),
  };
}

async function seedDoc(ctx, workspaceId, text) {
  const { h, lib, store } = ctx;
  const versionId = await h.seed(workspaceId);
  const { rows } = await h.fx.fixture.query(
    "select document_id from document_versions where id = $1",
    [versionId],
  );
  const key = lib.documentObjectKey(
    lib.parseWorkspaceId(workspaceId),
    lib.parseDocumentId(rows[0].document_id),
    lib.parseDocumentVersionId(versionId),
  );
  store.objects.set(key, Buffer.from(text));
  return versionId;
}

async function seedItems(ctx, workspaceId, docs) {
  const items = [];
  for (const doc of docs) {
    const expectedChunks = ctx.lib.chunkFixedWindow({ format: "text", text: doc.text }, randomUUID)
      .chunks.length;
    items.push({ ...doc, expectedChunks, versionId: await seedDoc(ctx, workspaceId, doc.text) });
  }
  await ctx.h.drainOutbox();
  return items;
}

/** Enqueues the documents (one at a time when `sequential`) and waits for every job to end. */
async function drive({ items, queue, jobs, sequential, workspaceId, enqueuedAt }) {
  const send = (item) => {
    enqueuedAt.set(item.versionId, now());
    return queue.enqueue({
      jobId: `bench-${item.versionId}`,
      workspaceId,
      versionId: item.versionId,
    });
  };
  for (const [i, item] of items.entries()) {
    await send(item);
    if (sequential) await jobs.until(i + 1);
  }
  if (!sequential) await jobs.until(items.length);
}

const countBy = (list, key) =>
  Object.fromEntries(Object.entries(Object.groupBy(list, key)).map(([k, v]) => [k, v.length]));

/** Everything a scenario reports, from what was recorded between its snapshots. */
async function report(ctx, run) {
  const { h, probe } = ctx;
  const { items, enqueuedAt, from, before, after, loadOver, wallMs, jobs } = run;
  const transactions = probe.transactions.slice(from.tx);
  const rows = versionRows(items, ctx.events.slice(from.events), transactions, enqueuedAt);
  const done = rows.filter((r) => r.activation);
  const chunks = done.reduce((a, r) => a + r.expectedChunks, 0);
  const db = await delta(h.fx.fixture, before, after);
  const saturated = saturation({
    load: loadOver,
    postgresCpuMs: db.postgresCpuMs,
    postgresIntervalMs: db.intervalMs,
    postgresCpuLimit: ctx.postgresCpuLimit,
  });
  return {
    countsBefore: before.counts,
    dataset: {
      documents: items.length,
      chars: items.reduce((a, i) => a + i.text.length, 0),
      expectedChunks: items.reduce((a, i) => a + i.expectedChunks, 0),
    },
    jobs: items.length,
    wallMs,
    completed: done.length,
    docsPerMinute: (done.length / wallMs) * 60_000,
    chunksPerSecond: (chunks / wallMs) * 1000,
    load: { ...loadOver, ...saturated },
    db,
    sizesAfter: after.sizes,
    countsAfter: after.counts,
    summary: summaries(rows),
    versions: rows,
    verification: await verify(ctx, items),
    jobLog: jobs.kept,
    statementErrors: probe.errors.slice(from.errors),
    transactionOutcomes: countBy(transactions, (t) => t.outcome),
    activationTransactions: activations(transactions).length,
  };
}

/** Runs one scenario through the real consumer and returns everything measured. */
export async function runScenario(ctx, scenario) {
  const { name, concurrency, docs, workspaceId, sequential = false } = scenario;
  const { lib, h, redis, events, probe } = ctx;
  const queueName = `cvbench-${randomUUID()}`;
  const queue = lib.createJobQueue({ connection: redis, queueName, enqueueTimeoutMs: 15_000 });
  const items = await seedItems(ctx, workspaceId, docs);
  const jobs = jobLog();
  const consumer = await lib.createIngestionConsumer({
    redisUrl: ctx.redisUrl,
    uow: tracedUow(ctx),
    stages: tracedStages(ctx),
    newId: randomUUID,
    queueName,
    concurrency,
    log: jobs.log,
  });
  const from = {
    events: events.length,
    tx: probe.transactions.length,
    errors: probe.errors.length,
  };
  const enqueuedAt = new Map();
  const before = await snapshot(h.fx.fixture, ctx.docker, ctx.postgres);
  const meter = startLoadMeter();
  const start = now();
  let wallMs;
  try {
    await drive({ items, queue, jobs, sequential, workspaceId, enqueuedAt });
    wallMs = now() - start;
  } finally {
    await consumer.close();
    await queue.close();
  }
  const loadOver = meter.stop();
  const after = await snapshot(h.fx.fixture, ctx.docker, ctx.postgres);
  const { group = null, round = null, position = null } = scenario;
  const measured = await report(ctx, {
    items,
    enqueuedAt,
    from,
    before,
    after,
    loadOver,
    wallMs,
    jobs,
  });
  return { name, group, round, position, concurrency, sequential, ...measured };
}
