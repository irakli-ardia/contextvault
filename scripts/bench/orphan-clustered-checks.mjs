// Independent checks for the clustered-backlog benchmark; pure functions, no database.
// Three layers, kept apart on purpose: (1) EXPLAIN accounting read from the plan only where its
// physical shape supports it, (2) reconciliation against an oracle computed from the tables, and
// (3) classification of the timings against the predefined targets (P1-P6).

export const TARGETS = {
  pageMs: 1500, // 10% of the worker's 15 s statement timeout
  controlHeadMs: 10, // control page 1 and the 50% mark
  perCandidateFactor: 3, // x the control's median microseconds per qualified candidate
  c3VsC2Median: 1.1,
  c3VsC2Single: 1.5,
  c3VsC2MinDiffMs: 10,
  near: 1.2, // over the target by up to 20% is inconclusive (NEAR), beyond it FAIL
};

function* walk(node) {
  yield node;
  for (const child of node.Plans ?? []) yield* walk(child);
}

const SCANS = new Set(["Index Scan", "Index Only Scan"]);
const NOT_COMPARABLE = (reason) => ({ comparable: false, reason });

/**
 * E (examined by the version scan), R1 (rejected by its filter), Q (reached the lateral aggregate),
 * R2 (rejected after it) and O (returned), from one EXPLAIN (ANALYZE, FORMAT JSON) report. Read only
 * from Limit -> Nested Loop over a single-loop index scan with an `attempt` filter and a lateral
 * Aggregate, bare or under a Subquery Scan. The aggregate yields at most one row per loop, so
 * R2 = Q - rows the Nested Loop emitted; no filter or rounded per-loop counter is used.
 * Any other shape is reported as not comparable, never guessed.
 */
// fallow-ignore-next-line complexity
export function extractAccounting(report) {
  const root = report.Plan;
  const all = [...walk(root)];
  if (all.some((n) => n["Node Type"].startsWith("Gather") || n["Parallel Aware"])) {
    return NOT_COMPARABLE("parallel plan");
  }
  if (all.some((n) => n["Node Type"] === "Memoize")) return NOT_COMPARABLE("memoize node");
  const nl = root["Node Type"] === "Limit" ? root.Plans?.[0] : root;
  if (nl?.["Node Type"] !== "Nested Loop" || nl.Plans?.length !== 2) {
    return NOT_COMPARABLE("no nested loop under the limit");
  }
  const wrapper = nl.Plans.find((n) => n["Node Type"] === "Subquery Scan");
  const inner = wrapper ? wrapper.Plans?.[0] : nl.Plans.find((n) => n["Node Type"] === "Aggregate");
  const outer = nl.Plans.find((n) => n !== (wrapper ?? inner));
  if (inner?.["Node Type"] !== "Aggregate" || (wrapper && wrapper.Plans.length !== 1)) {
    return NOT_COMPARABLE("no lateral aggregate");
  }
  if (!SCANS.has(outer["Node Type"])) return NOT_COMPARABLE(`outer path is ${outer["Node Type"]}`);
  if (outer["Actual Loops"] !== 1) return NOT_COMPARABLE("outer scan looped");
  const filter = String(outer.Filter ?? "");
  if (!/attempt/.test(filter) || /status|updated_at/.test(filter)) {
    return NOT_COMPARABLE("outer filter is not the attempt filter");
  }
  const r1 = outer["Rows Removed by Filter"] ?? 0;
  const q = inner["Actual Loops"];
  if (q !== outer["Actual Rows"]) return NOT_COMPARABLE("aggregate loops differ from outer rows");
  if (wrapper && wrapper["Actual Loops"] !== q) return NOT_COMPARABLE("subquery loops differ");
  const r2 = q - nl["Actual Rows"];
  return { comparable: true, e: outer["Actual Rows"] + r1, r1, q, r2, o: root["Actual Rows"] };
}

/** Plan accounting against the oracle: exact equality, plus E = R1 + Q and Q = R2 + O. */
export function reconcile(acc, oracle) {
  if (!acc.comparable) return [];
  const bad = ["e", "r1", "q", "r2", "o"].filter((k) => acc[k] !== oracle[k]);
  const problems = bad.map((k) => `${k}: plan ${acc[k]} != oracle ${oracle[k]}`);
  if (acc.e !== acc.r1 + acc.q) problems.push("plan: e != r1 + q");
  if (acc.q !== acc.r2 + acc.o) problems.push("plan: q != r2 + o");
  return problems;
}

/** Plan acceptability (P2): hard failures, plus a review note for any non-expected shape. */
export function planShape(report) {
  const all = [...walk(report.Plan)];
  const fail = [];
  if (all.some((n) => n["Node Type"] === "Seq Scan" && n["Relation Name"] === "outbox")) {
    fail.push("seq scan on outbox");
  }
  if (all.some((n) => n["Sort Space Type"] === "Disk")) fail.push("sort spills to disk");
  if (all.some((n) => n["Node Type"] === "Gather")) fail.push("gather without merge");
  const acc = extractAccounting(report);
  return { fail, review: acc.comparable ? null : acc.reason };
}

/** V3: one page of the production source against its scenario; `ranks` maps version id -> rank. */
export function checkPage({ rows, ranks, afterRank, limit, complete, windows, oracle }) {
  const problems = [];
  const at = rows.map((r) => ranks.get(r.versionId));
  if (at.some((r) => r === undefined)) problems.push("a returned row is not a waiting version");
  if (at.some((r, k) => r <= (k === 0 ? afterRank : at[k - 1])))
    problems.push("rows not ascending after the cursor");
  if (windows.some((w) => at.some((r) => r >= w.lo && r < w.hi)))
    problems.push("row inside a cluster window");
  if (complete && rows.length !== limit) problems.push(`complete page has ${rows.length} rows`);
  if (!complete && rows.length >= limit) problems.push("incomplete page is full");
  if (rows.length !== oracle.o) problems.push(`source returned ${rows.length}, oracle ${oracle.o}`);
  return problems;
}

/** V2 over a window: all rows of the right kind (live / cooldown / mixed), none exhausted or deleted. */
export function windowProblems(oracle, { lo, hi, kind }) {
  const size = hi - lo;
  const problems = [];
  if (oracle.e !== size) problems.push(`window holds ${oracle.e} rows, expected ${size}`);
  if (oracle.r1 > 0 || oracle.deleted > 0) problems.push("exhausted or deleted row in window");
  if (oracle.live + oracle.cooling !== oracle.q)
    problems.push("window row neither live nor cooling");
  if (kind === "live" && oracle.cooling > 0) problems.push("cooling row in live window");
  if (kind === "cooldown" && oracle.live > 0) problems.push("live row in cooldown window");
  if (kind === "mixed" && (oracle.live === 0 || oracle.cooling === 0))
    problems.push("mixed window is not mixed");
  return problems;
}

/** V1/V2: the expected synthetic counts against `countScenarios` from the database. */
export function compareCounts(expected, actual) {
  return Object.keys(expected)
    .filter((k) => expected[k] !== actual[k])
    .map((k) => `${k}: expected ${expected[k]}, database ${actual[k]}`);
}

export const isNoisy = (runsMs) =>
  Math.max(...runsMs) / Math.min(...runsMs) > 1.5 && Math.max(...runsMs) - Math.min(...runsMs) > 2;

/** PASS within the target, NEAR up to 20% over, FAIL beyond. */
export function grade(value, limit) {
  if (value <= limit) return "PASS";
  return value <= limit * TARGETS.near ? "NEAR" : "FAIL";
}

const RANK = { PASS: 0, NEAR: 1, FAIL: 2 };
const worst = (grades) => grades.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "PASS");
const median = (values) => {
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
};
export const headLimit = (e) => (e.dataset === "control" ? TARGETS.controlHeadMs : TARGETS.pageMs);

/**
 * P1-P6 over flat entries { dataset, scenario, config, status, complete, medianMs, q, shape, invalid }.
 * C0 and C1 timeouts are expected results and never fail anything. Incomplete pages count for P1 only.
 * Overall: INVALID (an accounting mismatch proves the data or the harness wrong) beats FAIL, which
 * beats INCONCLUSIVE (a successful complete-page C3 run whose plan shape could not be reconciled,
 * or a P5 with no C2/C3 pair to compare); otherwise the worst grade. INCONCLUSIVE never reports
 * PASS or NEAR. An unreconcilable plan on a declared incomplete page is not applicable instead: the
 * page only feeds P1, its returned rows are still checked (V3), and a comparable plan is reconciled.
 */
export function classify(entries, committed) {
  const c3 = entries.filter((e) => e.config === "C3");
  const done = c3.filter((e) => e.status === "ok" && e.complete);
  const us = (e) => (e.medianMs * 1000) / e.q;
  const controlDone = done.filter((e) => e.dataset === "control");
  const control = median(controlDone.map(us));
  const c3ControlMs = median(controlDone.map((e) => e.medianMs));
  const pairs = done.flatMap((a) => {
    const b = entries.find(
      (e) => e.config === "C2" && e.dataset === a.dataset && e.scenario === a.scenario,
    );
    return b?.status === "ok"
      ? [
          {
            id: `${a.dataset}/${a.scenario}`,
            ratio: a.medianMs / b.medianMs,
            diff: a.medianMs - b.medianMs,
          },
        ]
      : [];
  });
  const slow = pairs.filter(
    (p) => p.ratio > TARGETS.c3VsC2Single && p.diff > TARGETS.c3VsC2MinDiffMs,
  );
  const p1 = c3.filter((e) => e.status !== "ok").map((e) => `${e.dataset}/${e.scenario}`);
  const p2 = c3.filter((e) => e.shape?.fail.length);
  const clustered = done.filter((e) => e.dataset !== "control");
  const p5 = [
    grade(median(pairs.map((p) => p.ratio)), TARGETS.c3VsC2Median),
    slow.length ? "FAIL" : "PASS",
  ];
  const v = {
    P1: { verdict: p1.length ? "FAIL" : "PASS", detail: p1 },
    P2: {
      verdict: p2.length ? "FAIL" : "PASS",
      detail: p2.map((e) => `${e.dataset}/${e.scenario}: ${e.shape.fail}`),
      review: c3
        .filter((e) => e.shape?.review)
        .map((e) => `${e.dataset}/${e.scenario}: ${e.shape.review}`),
    },
    P3: { verdict: worst(done.map((e) => grade(e.medianMs, headLimit(e)))) },
    P4: {
      verdict: worst(clustered.map((e) => grade(us(e), control * TARGETS.perCandidateFactor))),
      controlUsPerCandidate: control,
    },
    P5: {
      verdict: pairs.length ? worst(p5) : "INCONCLUSIVE",
      pairs: pairs.length,
      medianRatio: median(pairs.map((p) => p.ratio)),
      slow,
    },
    P6: {
      verdict: "INFO",
      c0Control: entries.filter((e) => e.config === "C0" && e.dataset === "control"),
      committed,
      c3ControlMs,
      c3ControlVsCommitted: {
        low: c3ControlMs / committed.maxMs,
        high: c3ControlMs / committed.minMs,
      },
    },
  };
  const id = (e) => `${e.dataset}/${e.config}/${e.scenario}`;
  const invalid = entries.filter((e) => e.invalid).map(id);
  const unsupported = c3.filter(
    (e) => e.status === "ok" && e.accounting && !e.accounting.comparable,
  );
  const text = (e) => `${id(e)}: ${e.accounting.reason}`;
  const inconclusive = unsupported.filter((e) => e.complete).map(text);
  const notApplicable = unsupported.filter((e) => !e.complete).map(text);
  let verdict = inconclusive.length ? "INCONCLUSIVE" : "PASS";
  if (invalid.length) verdict = "INVALID";
  const grades = ["P1", "P2", "P3", "P4", "P5"].map((k) => v[k].verdict);
  const noPairs = v.P5.verdict === "INCONCLUSIVE";
  let overall = worst(grades.filter((g) => g !== "INCONCLUSIVE"));
  if (overall !== "FAIL" && (inconclusive.length || noPairs)) overall = "INCONCLUSIVE";
  if (invalid.length) overall = "INVALID";
  return { ...v, V4: { verdict, invalid, inconclusive, notApplicable }, overall };
}

/** Range of the committed post-VACUUM worker timings for A+B-no-include (original benchmark). */
export function committedRange(original) {
  const ms = original.runs
    .filter(
      (r) =>
        r.status === "ok" &&
        r.phase === "post-vacuum" &&
        r.role === "worker" &&
        r.variant === "A+B-no-include",
    )
    .map((r) => r.summary.executionMs);
  return { minMs: Math.min(...ms), maxMs: Math.max(...ms) };
}
