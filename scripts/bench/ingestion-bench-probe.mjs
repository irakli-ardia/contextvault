// Statement- and transaction-level timing for the ingestion benchmark. It wraps `pg.Client.query`
// in the benchmark process only; the SQL text it sees holds placeholders, never document content,
// and only a label and a duration are kept.

import { performance } from "node:perf_hooks";

// The more specific `of dv` rule comes before `of d`.
const RULES = [
  [/^begin/i, "begin"],
  [/^commit/i, "commit"],
  [/^rollback/i, "rollback"],
  [/insert into "sections"/i, "sections"],
  [/insert into "chunk_embeddings"/i, "embeddings"],
  [/insert into "chunks"/i, "chunks"],
  [/set status = 'ready'/i, "markReady"],
  [/update documents d set active_version_id/i, "movePointer"],
  [/for no key update of dv\b/i, "lockVersion"],
  [/for no key update of d\b/i, "lockDocument"],
];

export const classify = (text) => RULES.find(([re]) => re.test(text))?.[1] ?? "other";

/** Nearest-rank percentiles, the conventional median for an even count is the mean of the middle two. */
export function summary(values) {
  if (values.length === 0) return { n: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
  const mid = sorted.length / 2;
  const median = Number.isInteger(mid)
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[Math.floor(mid)];
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    min: sorted[0],
    median,
    p95: at(95),
    max: sorted.at(-1),
    mean: sum / sorted.length,
  };
}

/**
 * Patches `Client.prototype.query` (promise style only; the pool's own callback calls are not
 * transactions). Each begin..commit/rollback on one client becomes a record whose `labels` holds
 * every statement duration by label and `tag` is whatever `tag()` returned when it began (the
 * caller's async-context id, to join a transaction to the call that opened it). Returns the live
 * records and a restore function.
 */
export function installProbe(Client, clock = performance, tag = () => undefined) {
  const original = Client.prototype.query;
  const open = new WeakMap();
  const transactions = [];
  const errors = [];
  Client.prototype.query = function probed(config, ...rest) {
    const text = typeof config === "string" ? config : config?.text;
    const label = typeof text === "string" ? classify(text) : "other";
    const start = clock.now();
    const result = original.call(this, config, ...rest);
    if (typeof result?.then !== "function") return result;
    const done = (error) => {
      const end = clock.now();
      if (error) errors.push({ label, code: error.code ?? error.name });
      if (label === "begin") {
        open.set(this, { startedAtMs: start, labels: {}, tag: tag() });
        return;
      }
      const tx = open.get(this);
      if (!tx) return;
      const timings = tx.labels[label] ?? [];
      timings.push(end - start);
      tx.labels[label] = timings;
      if (label === "commit" || label === "rollback") {
        tx.outcome = error ? "error" : label;
        tx.totalMs = end - tx.startedAtMs;
        tx.commitMs = end - start;
        transactions.push(tx);
        open.delete(this);
      }
    };
    return result.then(
      (value) => {
        done();
        return value;
      },
      (error) => {
        done(error);
        throw error;
      },
    );
  };
  return {
    transactions,
    errors,
    restore: () => {
      Client.prototype.query = original;
    },
  };
}

/** The activation transaction is the one that inserted chunks. */
export const activations = (transactions) => transactions.filter((t) => t.labels.chunks);

const sum = (list = []) => list.reduce((a, b) => a + b, 0);

/**
 * Per-activation breakdown in ms. Every `*ClientMs` value is client-observed (statement sent to
 * result received in this process): it includes driver and event-loop delay and is not
 * PostgreSQL execution time. `activationTxMs` is begin to commit as seen by the client.
 */
export function breakdown(tx) {
  const l = tx.labels;
  return {
    activationTxMs: tx.totalMs,
    chunkInsertClientMs: sum(l.chunks),
    chunkStatements: l.chunks?.length ?? 0,
    longestChunkStatementClientMs: Math.max(0, ...(l.chunks ?? [])),
    embeddingInsertClientMs: sum(l.embeddings),
    sectionInsertClientMs: sum(l.sections),
    lockClientMs: sum(l.lockDocument) + sum(l.lockVersion),
    markReadyClientMs: sum(l.markReady),
    movePointerClientMs: sum(l.movePointer),
    commitClientMs: tx.commitMs,
    longestStatementClientMs: Math.max(
      0,
      ...Object.entries(l).flatMap(([k, v]) => (k === "begin" ? [] : v)),
    ),
  };
}
