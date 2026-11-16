// Pure rules for the optional PostgreSQL statement statistics: which normalized statement is which
// class, how entries of one snapshot combine, whether the server's call counts agree with the
// client probe's, and what a lock-wait log line yields. No query text, query id or parameter ever
// leaves this module's inputs: results hold classes, counts and numbers only.

// Text is whitespace-collapsed first. Literals are already `$n` in the server's text, so the rules
// anchor on table names and aliases, never on literals. `queryid` is deliberately never read: it
// hashes object ids and means nothing across independently initialised databases.
const RULES = [
  [/^begin\b/i, "begin"],
  [/^commit\b/i, "commit"],
  [/^rollback\b/i, "rollback"],
  [/^insert into "sections"/i, "sections"],
  [/^insert into "chunk_embeddings"/i, "embeddings"],
  [/^insert into "chunks"/i, "chunks"],
  [/^update document_versions dv set status = \$\d+, updated_at = now\(\)/i, "markReady"],
  [/^update documents d set active_version_id = \$\d+/i, "movePointer"],
  [/ for no key update of dv\b/i, "lockVersion"],
  [/ for no key update of d\b/i, "lockDocument"],
];

/** Classes whose server calls must equal the client probe's count; the others are only reported. */
export const CHECKED = [
  "sections",
  "chunks",
  "embeddings",
  "lockDocument",
  "lockVersion",
  "markReady",
  "movePointer",
];

export const classify = (query) => {
  const text = String(query).replace(/\s+/g, " ").trim();
  return RULES.find(([re]) => re.test(text))?.[1] ?? "other";
};

const SUMS = [
  "calls",
  "rows",
  "totalExecMs",
  "sharedBlksHit",
  "sharedBlksRead",
  "sharedBlksDirtied",
  "sharedBlksWritten",
  "walBytes",
  "walRecords",
  "walFpi",
];

/**
 * Entries of one class (different row counts are different entries) as one figure set. The server
 * also keeps entries with no executed call (a statement that was parsed but cancelled or has not
 * finished): they carry no timing, so they are left out; with none left every timing is null,
 * which reads as "unavailable", never as zero.
 */
function combine(all) {
  const entries = all.filter((e) => e.calls > 0);
  if (entries.length === 0) {
    return {
      ...Object.fromEntries(SUMS.map((k) => [k, 0])),
      meanExecMs: null,
      minExecMs: null,
      maxExecMs: null,
      stddevExecMs: null,
    };
  }
  const total = Object.fromEntries(SUMS.map((k) => [k, entries.reduce((a, e) => a + e[k], 0)]));
  const mean = total.totalExecMs / total.calls;
  // Pooled population variance from each entry's own mean and standard deviation.
  const squares = entries.reduce(
    (a, e) => a + e.calls * (e.stddevExecMs ** 2 + (e.totalExecMs / e.calls) ** 2),
    0,
  );
  const variance = Math.max(0, squares / total.calls - mean ** 2);
  return {
    ...total,
    meanExecMs: mean,
    minExecMs: Math.min(...entries.map((e) => e.minExecMs)),
    maxExecMs: Math.max(...entries.map((e) => e.maxExecMs)),
    stddevExecMs: Math.sqrt(variance),
  };
}

/** The client's statement count per class in the window, from the probe's transaction records. */
export function clientCounts(transactions) {
  const counts = {};
  for (const tx of transactions) {
    for (const [label, timings] of Object.entries(tx.labels)) {
      counts[label] = (counts[label] ?? 0) + timings.length;
    }
  }
  return counts;
}

const windowReasons = (info, worker) => [
  ...(info === null || info === undefined ? ["statistics info unavailable"] : []),
  ...(info?.dealloc > 0 ? [`${info.dealloc} statement entries were evicted`] : []),
  ...(Object.values(worker)
    .flat()
    .every((e) => e.calls === 0)
    ? ["no worker-role statements recorded"]
    : []),
];

/** Figures of one class and its cross-check against the client's count (`null`: not comparable). */
function checkedClass(name, entries, client, clientErrors) {
  const clientCalls = CHECKED.includes(name) ? (client[name] ?? 0) : null;
  const figures = combine(entries);
  const comparable = clientCalls !== null && !clientErrors.some((e) => e.label === name);
  const callsMatch = comparable ? clientCalls === figures.calls : null;
  const reason =
    callsMatch === false ? [`${name}: server ${figures.calls} calls, client ${clientCalls}`] : [];
  return { figures: { ...figures, clientCalls, callsMatch }, reason };
}

/** Per-class figures with the client cross-check; a mismatch is a reason, never an adjustment. */
function classFigures(worker, client, clientErrors) {
  const checked = Object.entries(worker).map(([name, entries]) => [
    name,
    checkedClass(name, entries, client, clientErrors),
  ]);
  const missing = CHECKED.filter((n) => worker[n] === undefined && (client[n] ?? 0) > 0).map(
    (n) => `${n}: client ${client[n]} statements, none recorded by the server`,
  );
  return {
    classes: Object.fromEntries(checked.map(([name, c]) => [name, c.figures])),
    reasons: [...checked.flatMap(([, c]) => c.reason), ...missing],
  };
}

/**
 * One scenario's server figures. `rows` are the snapshot's entries (role name, text, counters);
 * only the worker role is classified. A class is cross-checked only when the client saw no
 * statement error of that class (an errored statement is not counted by the server, so the two
 * counts cannot be compared); otherwise the check is `null`: unavailable, not assumed equal.
 */
export function summarize({ rows, info, client, clientErrors = [] }) {
  const worker = Object.groupBy(
    rows.filter((r) => r.role === "contextvault_worker"),
    (r) => classify(r.query),
  );
  const found = classFigures(worker, client, clientErrors);
  const reasons = [...windowReasons(info, worker), ...found.reasons];
  const { other, ...named } = found.classes;
  return {
    valid: reasons.length === 0,
    invalidReasons: reasons,
    deallocations: info?.dealloc ?? null,
    statsResetAt: info?.statsReset ?? null,
    classes: named,
    other: other ?? null,
    appRoleCalls: rows
      .filter((r) => r.role === "contextvault_app")
      .reduce((a, r) => a + r.calls, 0),
  };
}

const WAITING = /still waiting for \w+ on .* after [\d.]+ ms/;
const ACQUIRED = /acquired \w+ on .* after ([\d.]+) ms/;

/** Counts and durations of lock waits in log text; no line, statement or identifier is kept. */
export function parseLockWaits(text) {
  const lines = String(text).split("\n");
  const waited = lines.filter((l) => WAITING.test(l)).length;
  const durations = lines.flatMap((l) => {
    const m = ACQUIRED.exec(l);
    return m ? [Number(m[1])] : [];
  });
  return {
    count: waited,
    resolved: durations.length,
    totalMs: durations.reduce((a, b) => a + b, 0),
    maxMs: Math.max(0, ...durations),
  };
}
