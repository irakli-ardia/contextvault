// Pure extraction of the measurements one scenario of an ingestion result records. It reads the
// harness's own serialization (`ingestion-bench-run.mjs`, `-measure`, `-load`, `-server-stats-rules`)
// and invents nothing: a value that is absent or not a finite number is `null`, never `0`.
// No string, array or object is ever coerced to a number and no input method is called.
// What the numbers mean for a comparison (primary metric, stalls, pairing, statistics) is not
// decided here. Server per-class figures are totals over a scenario, not per-activation times.

import { CHECKED } from "./ingestion-bench-server-stats-rules.mjs";
import { isRecord } from "./ingestion-compare-provenance.mjs";

export const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const bool = (v) => (typeof v === "boolean" ? v : null);
export const str = (v) => (typeof v === "string" ? v : null);
export const get = (o, k) => (isRecord(o) && Object.hasOwn(o, k) ? o[k] : undefined);
const dig = (o, ...path) => path.reduce((acc, k) => get(acc, k), o);
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, num(get(o, k))]));
const tally = (items) => {
  const counts = new Map();
  for (const key of items) counts.set(key, (counts.get(key) ?? 0) + 1);
  return Object.fromEntries(counts);
};

const STAT = ["n", "min", "median", "p95", "max", "mean"];
/**
 * Client timing fields this extractor selects from `summary[class]`. The harness also writes
 * `chunks`, `parseStageMs` and `activateUowMs`; they are deliberately not extracted.
 */
const TIMINGS = [
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
const DB = [
  "walBytes",
  "walBytesPerChunk",
  "chunksAdded",
  "chunkTableBytesPerChunk",
  "embeddingTableBytesPerChunk",
  "postgresCpuMs",
];
const COUNTERS = ["xact_commit", "xact_rollback", "deadlocks", "temp_files"];
const SIZES = ["heap", "indexes", "toastAndMaps"];
const TABLES = ["chunks", "sections", "chunk_embeddings"];
const SERVER_FIGURES = ["calls", "clientCalls", "totalExecMs", "maxExecMs", "rows", "walBytes"];
const LOAD = ["workerCpuCores", "postgresCpuCores"];

const classTimings = (s) => Object.fromEntries(TIMINGS.map((t) => [t, pick(get(s, t), STAT)]));

/** Per document class (`small`, `max`, `input-limit`, ...): the recorded statistics, or none. */
function timings(scenario) {
  const summary = get(scenario, "summary");
  if (!isRecord(summary)) return null;
  return Object.fromEntries(
    Object.entries(summary)
      .filter(([, group]) => isRecord(group))
      .map(([cls, group]) => [
        cls,
        {
          docs: num(get(group, "docs")),
          completed: num(get(group, "completed")),
          ...classTimings(group),
        },
      ]),
  );
}

function database(scenario) {
  const db = get(scenario, "db");
  if (!isRecord(db)) return null;
  const sizes = get(scenario, "sizesAfter");
  return {
    ...pick(db, DB),
    counters: pick(get(db, "counters"), COUNTERS),
    sizesAfter: Object.fromEntries(TABLES.map((t) => [t, pick(get(sizes, t), SIZES)])),
  };
}

function load(scenario) {
  const l = get(scenario, "load");
  if (!isRecord(l)) return null;
  const flags = get(l, "saturated");
  return {
    ...pick(l, LOAD),
    eventLoopUtilization: num(dig(l, "eventLoop", "utilization")),
    saturated: Array.isArray(flags) ? flags.filter((f) => typeof f === "string") : null,
  };
}

const DONE = "INGESTION_JOB_DONE";
const KIND_BY_CODE = { INGESTION_JOB_ERROR: "error", INGESTION_JOB_REJECTED: "rejected" };
const REASON_FIELD = { retry: "failure", failed: "failure", error: "reason", rejected: "reason" };

/** `processed`, `retry`, `failed` (a `DONE` outcome), `error`, `rejected`, or `other`. */
function eventKind(event) {
  const code = str(get(event, "code"));
  if (code !== null && Object.hasOwn(KIND_BY_CODE, code)) return KIND_BY_CODE[code];
  const outcome = str(get(event, "outcome"));
  const known = outcome === "processed" || outcome === "retry" || outcome === "failed";
  return code === DONE && known ? outcome : "other";
}

/**
 * Counts of the consumer's job-end events. An event carries no job id, so these are event counts,
 * never distinct jobs: one job that retries twice and then fails is two `retry` and one `failed`.
 * `failed` is a terminal outcome; `retry` is not. `reasons` tallies each kind's recorded
 * `failure` (retry, failed) or `reason` (error, rejected) code, `unknown` when absent.
 */
function jobEvents(log) {
  if (!Array.isArray(log)) return null;
  const counts = { processed: 0, retry: 0, failed: 0, error: 0, rejected: 0, other: 0 };
  const reasons = { retry: [], failed: [], error: [], rejected: [] };
  for (const event of log) {
    const kind = eventKind(event);
    counts[kind] += 1;
    if (kind !== "processed" && kind !== "other")
      reasons[kind].push(str(get(event, REASON_FIELD[kind])) ?? "unknown");
  }
  const tallies = Object.entries(reasons).map(([kind, list]) => [kind, tally(list)]);
  return { total: log.length, ...counts, reasons: Object.fromEntries(tallies) };
}

/** Failures and retries the harness recorded: outcomes, statement error codes, job events. */
function reliability(scenario) {
  const errors = get(scenario, "statementErrors");
  const statuses = dig(scenario, "verification", "statuses");
  const attempts = Array.isArray(statuses)
    ? statuses.map((s) => num(get(s, "attempt"))).filter((a) => a !== null)
    : [];
  return {
    transactionOutcomes: pick(get(scenario, "transactionOutcomes"), [
      "commit",
      "rollback",
      "error",
    ]),
    statementErrors: Array.isArray(errors)
      ? {
          total: errors.length,
          byCode: tally(
            errors.map((e) => `${str(get(e, "label")) ?? "?"}:${str(get(e, "code")) ?? "?"}`),
          ),
        }
      : null,
    jobEvents: jobEvents(get(scenario, "jobLog")),
    maxAttempt: attempts.reduce((max, a) => (max === null || a > max ? a : max), null),
  };
}

/** Server data as recorded, with the validity `checkServer` decided; `null` when not recorded. */
function server(scenario, validity) {
  const data = get(scenario, "serverStatements");
  if (!isRecord(data)) return null;
  const classes = get(data, "classes");
  const other = get(data, "other");
  return {
    status: str(get(validity, "status")),
    reasons: Array.isArray(get(validity, "reasons"))
      ? validity.reasons.filter((r) => typeof r === "string")
      : [],
    deallocations: num(get(data, "deallocations")),
    classes: Object.fromEntries(
      CHECKED.map((c) => [
        c,
        isRecord(get(classes, c))
          ? { ...pick(classes[c], SERVER_FIGURES), callsMatch: bool(get(classes[c], "callsMatch")) }
          : null,
      ]),
    ),
    other: isRecord(other) ? pick(other, ["calls", "totalExecMs", "maxExecMs"]) : null,
    appRoleCalls: num(get(data, "appRoleCalls")),
    lockWaits: isRecord(get(data, "lockWaits"))
      ? pick(data.lockWaits, ["count", "resolved", "totalMs", "maxMs"])
      : null,
  };
}

/**
 * The recorded measurements of one scenario. `validity` is the matching entry of
 * `validateResult(...).server.scenarios` (optional): it decides `server.status`, nothing else.
 * Never throws, never mutates `scenario`.
 */
export function scenarioMetrics(scenario, validity) {
  return {
    name: str(get(scenario, "name")),
    group: str(get(scenario, "group")),
    round: num(get(scenario, "round")),
    position: num(get(scenario, "position")),
    concurrency: num(get(scenario, "concurrency")),
    sequential: bool(get(scenario, "sequential")),
    documents: num(dig(scenario, "dataset", "documents")),
    expectedChunks: num(dig(scenario, "dataset", "expectedChunks")),
    jobs: num(get(scenario, "jobs")),
    completed: num(get(scenario, "completed")),
    activations: num(get(scenario, "activationTransactions")),
    wallMs: num(get(scenario, "wallMs")),
    docsPerMinute: num(get(scenario, "docsPerMinute")),
    verified: bool(dig(scenario, "verification", "ok")),
    timings: timings(scenario),
    db: database(scenario),
    load: load(scenario),
    reliability: reliability(scenario),
    server: server(scenario, validity),
  };
}
