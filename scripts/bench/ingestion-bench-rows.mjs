// Turns the recorded events and transactions of one scenario into per-document rows and summaries.

import { breakdown, summary } from "./ingestion-bench-probe.mjs";

const sumOf = (...values) => values.reduce((a, b) => a + (b ?? 0), 0);

const span = (e) => (e ? e.endMs - e.startMs : null);
const at = (e, key) => e?.[key] ?? null;
const between = (from, to) => (from === null || to === null ? null : to - from);

/** The events of one version, picked by what they are. */
function located(item, events) {
  const mine = events.filter(
    (e) => e.versionId === item.versionId || e.methods?.some((m) => m.versionId === item.versionId),
  );
  const uow = (method) => mine.find((e) => e.methods?.some((m) => m.method === method));
  const stage = (name) => mine.find((e) => e.type === "stage" && e.stage === name);
  return {
    claim: uow("claim"),
    transition: uow("transition"),
    activate: uow("activate"),
    parsing: stage("parsing"),
    chunking: stage("chunking"),
    error: mine.find((e) => e.error)?.error ?? null,
  };
}

function rowOf(item, e, transactions, enqueuedAt) {
  const { claim, transition, activate, parsing, chunking } = e;
  const tx = activate && transactions.find((t) => t.tag === activate.call);
  const embedMs = at(chunking?.sub, "embedMs");
  const stageMs = span(chunking);
  return {
    class: item.cls,
    chars: item.text.length,
    expectedChunks: item.expectedChunks,
    queueWaitMs: between(enqueuedAt, at(claim, "startMs")),
    claimUowMs: span(claim),
    parseStageMs: span(parsing),
    readBytesMs: at(parsing?.sub, "readMs"),
    childParseMs: at(parsing?.sub, "parseMs"),
    transitionUowMs: span(transition),
    chunkStageMs: stageMs,
    embedMs,
    chunkingMs: stageMs === null ? null : stageMs - sumOf(embedMs),
    activateUowMs: span(activate),
    processingMs: between(at(claim, "startMs"), at(activate, "endMs")),
    endToEndMs: between(enqueuedAt, at(activate, "endMs")),
    activation: tx ? breakdown(tx) : null,
    error: e.error,
  };
}

/** One row per version from the events and transactions recorded during a scenario. */
export function versionRows(items, events, transactions, enqueuedAt) {
  return items.map((item) =>
    rowOf(item, located(item, events), transactions, enqueuedAt.get(item.versionId)),
  );
}

const group = (rows, key) => Object.groupBy(rows, (r) => r[key]);
const pick = (rows, field) => rows.map((r) => r[field]).filter((v) => typeof v === "number");

/** Per-class summaries of the fields a reader compares against the targets. */
export function summaries(rows) {
  const out = {};
  for (const [cls, list] of Object.entries(group(rows, "class"))) {
    const done = list.filter((r) => r.activation);
    out[cls] = {
      docs: list.length,
      completed: done.length,
      chunks: summary(done.map((r) => r.activation && r.expectedChunks)),
      endToEndMs: summary(pick(done, "endToEndMs")),
      processingMs: summary(pick(done, "processingMs")),
      parseStageMs: summary(pick(done, "parseStageMs")),
      chunkStageMs: summary(pick(done, "chunkStageMs")),
      embedMs: summary(pick(done, "embedMs")),
      activateUowMs: summary(pick(done, "activateUowMs")),
      activationTxMs: summary(done.map((r) => r.activation.activationTxMs)),
      chunkInsertClientMs: summary(done.map((r) => r.activation.chunkInsertClientMs)),
      embeddingInsertClientMs: summary(done.map((r) => r.activation.embeddingInsertClientMs)),
      lockClientMs: summary(done.map((r) => r.activation.lockClientMs)),
      commitClientMs: summary(done.map((r) => r.activation.commitClientMs)),
      longestStatementClientMs: summary(done.map((r) => r.activation.longestStatementClientMs)),
    };
  }
  return out;
}

/**
 * Checks each seeded version against what must have happened: a document expected to be accepted
 * is `ready` with exactly the chunk count the production chunker predicts and one embedding per
 * chunk; one expected to be rejected has no chunks and is not `ready`.
 */
export function verifyCounts(items, rows) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const problems = [];
  for (const [index, item] of items.entries()) {
    const row = byId.get(item.versionId);
    if (!row) problems.push({ index, reason: "version missing" });
    else if (item.expect === "rejected") {
      if (row.chunks !== 0 || row.status === "ready")
        problems.push({ index, reason: "rejected document was activated" });
    } else if (row.status !== "ready") problems.push({ index, reason: `status ${row.status}` });
    else if (row.chunks !== item.expectedChunks)
      problems.push({ index, reason: `chunks ${row.chunks}, expected ${item.expectedChunks}` });
    else if (row.embeddings !== row.chunks)
      problems.push({ index, reason: `embeddings ${row.embeddings}, chunks ${row.chunks}` });
  }
  return {
    ok: problems.length === 0,
    checked: items.length,
    mismatchedVersions: problems.length,
    problems: problems.slice(0, 20),
  };
}
