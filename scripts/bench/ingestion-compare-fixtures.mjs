// Synthetic ingestion benchmark results for tests. Every field below is one the harness records
// (`ingestion-bench*.mjs`); the shapes of `schema`, `serverStats` and `serverStatements` come from
// the harness's own functions where one exists. Numbers are arbitrary, never measurements.

import { STORED_TSV_DDL } from "./ingestion-bench-schema.mjs";
import { parseLockWaits, summarize } from "./ingestion-bench-server-stats-rules.mjs";

export const SHA = "e300a89e300a89e300a89e300a89e300a89e300a";
export const LEGACY_SHA = "09fa52fd1da88bd0fde61ef4956df839496864f0";
const EMPTY_DIFF = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const IMAGE = "sha256:2358fcba361ed2233a5ed81b5fe4ca779ccb304120ce531a3bf51c0ed7e2bc11";

const CLASS_QUERIES = {
  sections: 'insert into "sections" ("id") values ($1)',
  chunks: 'insert into "chunks" ("id") values ($1)',
  embeddings: 'insert into "chunk_embeddings" ("id") values ($1)',
  markReady: "update document_versions dv set status = $1, updated_at = now() where dv.id = $2",
  movePointer: "update documents d set active_version_id = $1 where d.id = $2",
  lockVersion: "select 1 from document_versions dv where dv.id = $1 for no key update of dv",
  lockDocument: "select 1 from documents d where d.id = $1 for no key update of d",
};
const COUNTERS = {
  calls: 10,
  rows: 10,
  totalExecMs: 50,
  minExecMs: 1,
  maxExecMs: 9,
  stddevExecMs: 2,
  sharedBlksHit: 1,
  sharedBlksRead: 0,
  sharedBlksDirtied: 0,
  sharedBlksWritten: 0,
  walBytes: 100,
  walRecords: 1,
  walFpi: 0,
};

/** `summarize`'s own output for a window in which every activation class ran ten times. */
export function serverStatements({ dealloc = 0, omit = [] } = {}) {
  const names = Object.keys(CLASS_QUERIES).filter((n) => !omit.includes(n));
  const rows = names.map((n) => ({
    role: "contextvault_worker",
    query: CLASS_QUERIES[n],
    ...COUNTERS,
  }));
  const client = Object.fromEntries(names.map((n) => [n, COUNTERS.calls]));
  const info = { dealloc, statsReset: "2026-11-20T10:00:00.000Z" };
  return { ...summarize({ rows, info, client }), lockWaits: parseLockWaits("") };
}

const READY = { status: "ready", attempt: 1, error_stage: null, error_code: null, versions: 10 };
const OVERSIZE = { stage: "parsing", failure: "parse.text_too_large" };
const stat = (median) => ({ n: 10, min: median, median, p95: median, max: median, mean: median });
const SCENARIOS = [
  ["sequential-small", "small"],
  ["sequential-medium", "medium"],
  ["sequential-large", "large"],
  ["sequential-max", "max"],
  ["oversize-input", "max"],
  ["burst-20-max-c1-r1", "max"],
  ["burst-20-max-c2-r1", "max"],
  ["burst-20-max-c4-r1", "max"],
  ["burst-20-max-c2-r2", "max"],
  ["burst-20-max-c4-r2", "max"],
  ["burst-20-max-c1-r2", "max"],
  ["burst-20-max-c4-r3", "max"],
  ["burst-20-max-c1-r3", "max"],
  ["burst-20-max-c2-r3", "max"],
  ["workspace-mixed-c2", "small"],
];

function scenario([name, size], { serverStats, embedMs }) {
  const rejected = name === "oversize-input";
  return {
    name,
    concurrency: Number(/-c(\d)/.exec(name)?.[1] ?? 1),
    sequential: name.startsWith("sequential") || rejected,
    summary: { [size]: { docs: 10, embedMs: stat(embedMs) } },
    verification: {
      statuses: [READY],
      ok: true,
      checked: 10,
      mismatchedVersions: 0,
      problems: [],
    },
    statementErrors: [],
    transactionOutcomes: { commit: 10 },
    activationTransactions: rejected ? 0 : 10,
    ...(serverStats ? { serverStatements: serverStatements() } : {}),
  };
}

const TIMING_FIELDS = [
  "endToEndMs",
  "processingMs",
  "chunkStageMs",
  "embedMs",
  "activationTxMs",
  "chunkInsertClientMs",
  "embeddingInsertClientMs",
  "lockClientMs",
  "commitClientMs",
  "longestStatementClientMs",
];

/** A scenario with every measured block the harness serializes (`summary`, `db`, `load`, jobs). */
export function fullScenario(
  name = "sequential-max",
  { serverStats = true, oversize = false } = {},
) {
  const base = scenario([name, "max"], { serverStats, embedMs: 750 });
  const timings = Object.fromEntries(TIMING_FIELDS.map((f, i) => [f, stat(100 + i)]));
  return {
    ...base,
    group: null,
    round: null,
    position: null,
    dataset: { documents: 10, chars: 20_000_000, expectedChunks: 11130 },
    jobs: 10,
    wallMs: 17080.5,
    completed: oversize ? 0 : 10,
    docsPerMinute: oversize ? 0 : 35.1,
    load: {
      workerCpuCores: 0.61,
      eventLoop: { utilization: 0.58 },
      postgresCpuCores: 0.27,
      saturated: [],
    },
    db: {
      walBytes: 112594592,
      walBytesPerChunk: 10116,
      chunksAdded: oversize ? 0 : 11130,
      chunkTableBytesPerChunk: 3196,
      embeddingTableBytesPerChunk: 8435,
      postgresCpuMs: 5149.1,
      counters: { xact_commit: 109, xact_rollback: 0, deadlocks: 0, temp_files: 0 },
    },
    sizesAfter: { chunks: { heap: 3284992, indexes: 4472832, toastAndMaps: 49717248 } },
    summary: { max: { docs: 10, completed: oversize ? 0 : 10, ...timings } },
    jobLog: Array(10).fill(oversize ? done("failed", OVERSIZE) : done("processed")),
  };
}

const done = (outcome, extra) => ({ code: "INGESTION_JOB_DONE", outcome, ...extra });
const storedSchema = () => ({
  arm: "stored-tsv",
  verified: true,
  ddl: STORED_TSV_DDL.split("\n"),
  column: {
    type: "tsvector",
    generated: "s",
    notNull: true,
    expression: "to_tsvector('simple'::regconfig, content)",
  },
});

const container = (image, memory, cpus, pids) => ({
  image: `${image}@${IMAGE}`,
  imageId: IMAGE,
  memoryLimitBytes: memory,
  cpuLimit: cpus,
  pidsLimit: pids,
});

/**
 * A complete, valid run. `index` makes ids, file name and start time unique; `arm` is `baseline`
 * or `stored-tsv`; `serverStats` mirrors the `--server-stats` flag; `embedMs` is the control value.
 */
export function makeRun({ arm = "baseline", index = 0, serverStats = true, embedMs = 750 } = {}) {
  const start = Date.UTC(2026, 10, 20, 9, 0, 0) + index * 600_000;
  const schemaArg = arm === "baseline" ? [] : [`--schema=${arm}`];
  const flags = serverStats ? ["--server-stats"] : [];
  return {
    benchmark: "ingestion",
    experimentId: `ingestion-00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    runId: String(index).padStart(8, "0"),
    status: "complete",
    startedAt: new Date(start).toISOString(),
    cli: {
      command: "run",
      arguments: [
        "run",
        "--execute",
        ...flags,
        "--repeats=10",
        "--rounds=3",
        ...schemaArg,
        `--out=run${index}.json`,
      ],
    },
    config: {
      smoke: false,
      repeats: 10,
      rounds: 3,
      concurrencyLevels: [1, 2, 4],
      documentCharsByClass: { small: 20000, medium: 200000, large: 1000000, max: 2000000 },
      workspaceMix: { small: 30, medium: 14, large: 5, max: 1 },
      discardedWarmups: 1,
      outputFile: `run${index}.json`,
      ...(serverStats ? { serverStats: true } : {}),
    },
    gitSha: SHA,
    workingTreeDirty: false,
    dirtyFiles: [],
    dirtyFilesTruncated: false,
    diffSha256: EMPTY_DIFF,
    containers: {
      postgres: container("pgvector/pgvector:0.8.7-pg18", 4294967296, 2, 512),
      redis: container("redis:8.2-alpine", 1073741824, 1, 256),
    },
    schema: arm === "baseline" ? { arm, verified: true, ddl: [], column: null } : storedSchema(),
    ...(serverStats
      ? {
          serverStats: {
            enabled: true,
            containerIdentityVerified: true,
            extensionSchema: "bench_stats",
            settings: { shared_preload_libraries: "pg_stat_statements" },
            roleChecks: [],
          },
        }
      : {}),
    scenarios: SCENARIOS.map((s) => scenario(s, { serverStats, embedMs })),
    environment: {
      appStatementTimeout: "15s",
      postgres: "PostgreSQL 18.6",
      pgvector: "0.8.7",
      settings: { shared_buffers: "16384", statement_timeout: "0" },
      rowsBeforeSeed: { chunks: 0, workspaces: 0 },
      node: "v24.22.1",
      cpu: "Apple M1 Pro x8",
      memoryGb: 16,
      platform: "darwin 25.6.0",
      runsPerMeasurement: 10,
      smoke: false,
    },
    cleanup: { postgres: { removed: true }, redis: { removed: true }, verified: true },
    completedAt: new Date(start + 540_000).toISOString(),
  };
}

/** A run from before the schema arms: no `schema`, no server statistics, the baseline commit. */
export function legacyRun(index = 0) {
  const run = makeRun({ index, serverStats: false });
  return { ...changed(run, (r) => delete r.schema), gitSha: LEGACY_SHA };
}

/** A deep copy changed by `edit`, so one fixture never leaks into another test. */
export function changed(run, edit) {
  const copy = structuredClone(run);
  edit(copy);
  return copy;
}
