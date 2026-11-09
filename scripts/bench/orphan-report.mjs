// Renders benchmarks/orphan-discovery/report.md from the measured results; no number is typed here.

const ms = (value) => (value < 10 ? value.toFixed(2) : value.toFixed(0));
// fallow-ignore-next-line complexity
const cell = (run) => {
  if (run === undefined) return "-";
  if (run.status === "timeout") return `TIMEOUT (est. cost ${Math.round(run.estimate.totalCost)})`;
  const s = run.summary;
  const fetches = s.scans.filter((n) => n.heapFetches !== undefined).map((n) => n.heapFetches);
  const io = `hit ${s.sharedHit} / read ${s.sharedRead ?? 0}`;
  return `${ms(s.executionMs)} ms (${io}${fetches.length ? `, heap fetches ${fetches.join("+")}` : ""})`;
};

function matrix(result, phase, role, variants) {
  const scenarios = result.scenarios.map((s) => s.key);
  const lines = [
    `| variant | ${scenarios.join(" | ")} |`,
    `|---|${scenarios.map(() => "---").join("|")}|`,
  ];
  for (const variant of variants) {
    const runs = scenarios.map((sc) =>
      cell(
        result.runs.find(
          (r) => r.phase === phase && r.variant === variant && r.role === role && r.scenario === sc,
        ),
      ),
    );
    lines.push(`| ${variant} | ${runs.join(" | ")} |`);
  }
  return lines.join("\n");
}

function lockTable(result, phase) {
  const lines = [
    "| variant | role | statement 1 median / max ms | statement 2 median / max ms |",
    "|---|---|---|---|",
  ];
  for (const l of result.lock.filter((x) => x.phase === phase)) {
    const [one, two] = l.statements;
    lines.push(
      `| ${l.variant} | ${l.role} | ${ms(one.medianMs)} / ${ms(one.maxMs)} | ${ms(two.medianMs)} / ${ms(two.maxMs)} |`,
    );
  }
  return lines.join("\n");
}

// fallow-ignore-next-line complexity
export function renderReport(result) {
  const variants = [...new Set(result.runs.map((r) => r.variant))];
  const out = [
    "# Orphan discovery benchmark (generated)",
    `Run ${result.startedAt} to ${result.completedAt}. Image \`${result.environment.image}\`, PostgreSQL server_version_num ${result.environment.serverVersionNum}, 127.0.0.1:${result.environment.port}, tmpfs only. Migrations applied: ${result.migrations}.`,
    `Settings: ${JSON.stringify(result.environment.settings)}; worker statement_timeout ${result.environment.workerStatementTimeout}; privileged timeout 60 s.`,
    "## Dataset",
    "```json",
    JSON.stringify(result.dataset, null, 2),
    "```",
    `Scenarios (page size 500): ${JSON.stringify(result.scenarios)}. Rows visible to contextvault_owner (FORCE RLS, no owner policy): ${result.ownerVisibleRows}.`,
    "## Baseline scaling (page 1, privileged)",
    result.ladder
      .map(
        (l) =>
          `- ${l.waiting} waiting: ${l.status === "ok" ? `${ms(l.executionMs)} ms` : "TIMEOUT"}`,
      )
      .join("\n"),
    "## Visibility map",
    "```json",
    JSON.stringify(result.visibility, null, 2),
    "```",
  ];
  for (const phase of ["pre-vacuum", "post-vacuum"]) {
    for (const role of ["privileged", "worker"]) {
      out.push(
        `## ${phase}, role ${role}: discovery execution time (shared buffers)`,
        matrix(result, phase, role, variants),
      );
    }
    out.push(`## ${phase}: lockOrphan (16 versions x 3 runs)`, lockTable(result, phase));
    out.push(`### ${phase}: index sizes and build times`);
    for (const v of variants) {
      const info = result.variants[`${phase}/${v}`];
      out.push(
        `- ${v}: ${JSON.stringify(info.sizes)}; build ms ${info.built.map((b) => b.buildMs).join(", ") || "-"}`,
      );
    }
  }
  out.push(`## Cleanup`, "```json", JSON.stringify(result.cleanup, null, 2), "```");
  return `${out.join("\n\n")}\n`;
}

const table = (header, rows) =>
  [
    `| ${header.join(" | ")} |`,
    `|${header.map(() => "---").join("|")}|`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");

// fallow-ignore-next-line complexity
function clusteredCell(e) {
  if (e === undefined) return "-";
  if (e.status !== "ok") {
    return `TIMEOUT, at least the statement timeout (est. cost ${Math.round(e.estimate.totalCost)})`;
  }
  const flags = [e.invalid && "INVALID", e.earlier && "repeated", e.jit && "JIT"].filter(Boolean);
  const tag = flags.length ? ` (${flags.join(", ")})` : "";
  return `${ms(e.medianMs)} ms, ${e.usPerCandidate.toFixed(2)} us/cand, hit ${e.sharedHit}/read ${e.sharedRead}${tag}`;
}

function clusteredMatrix(result, dataset) {
  const configs = ["C0", "C1", "C2", "C3"];
  const rows = dataset.scenarios.map((sc) => [
    `${sc.key}${sc.complete ? "" : " (incomplete)"}`,
    ...configs.map((c) =>
      clusteredCell(
        result.entries.find(
          (e) => e.dataset === dataset.key && e.config === c && e.scenario === sc.key,
        ),
      ),
    ),
  ]);
  return table(["scenario", ...configs], rows);
}

function accountingRows(result) {
  return result.entries
    .filter((e) => e.config === "C3" && e.status === "ok")
    .map((e) => {
      const a = e.accounting;
      const unsupported = e.complete ? "not comparable" : "not applicable (incomplete page)";
      const plan = a.comparable
        ? `${a.e}/${a.r1}/${a.q}/${a.r2}/${a.o}`
        : `${unsupported}: ${a.reason}`;
      const o = e.oracle;
      return [
        `${e.dataset}/${e.scenario}`,
        plan,
        `${o.e}/${o.r1}/${o.q}/${o.r2}/${o.o}`,
        e.mismatches.join("; ") || "-",
      ];
    });
}

// Plain facts only: every number comes from `result`, and the limits below are stated, not measured.
export function renderClustered(result) {
  const v = result.verdicts;
  const env = result.environment;
  const out = [
    `# Orphan discovery, clustered backlog (generated${result.smoke ? ", SMOKE: harness check, not a result" : ""})`,
    `Run ${result.startedAt} to ${result.completedAt}. Image \`${env.image}\`, server_version_num ${env.serverVersionNum}, 127.0.0.1:${env.port}, tmpfs only. Migrations: ${result.migrations}. Waiting versions per dataset: ${result.waiting}; page size ${result.page}; role worker (statement_timeout ${env.workerStatementTimeout}); post-VACUUM only.`,
    `Settings: ${JSON.stringify(env.settings)}. Targets (predefined engineering targets, not guarantees): ${JSON.stringify(result.targets)}.`,
    `## Verdict: ${v.overall}`,
    table(
      ["criterion", "verdict", "detail"],
      ["P1", "P2", "P3", "P4", "P5", "V4"].map((k) => {
        const { verdict, ...rest } = v[k];
        const shown = v.overall === "INVALID" && k !== "V4" ? "not graded (run INVALID)" : verdict;
        return [k, shown, `\`${JSON.stringify(rest)}\``];
      }),
    ),
    `P6 (informational): C0 on the control ${JSON.stringify(v.P6.c0Control.map((e) => [e.scenario, e.status, e.medianMs]))}; committed A+B-no-include post-VACUUM worker range ${v.P6.committed.minMs.toFixed(2)}-${v.P6.committed.maxMs.toFixed(2)} ms (original run, possibly other conditions); C3 on the control ${v.P6.c3ControlMs.toFixed(2)} ms = ${v.P6.c3ControlVsCommitted.low.toFixed(2)}-${v.P6.c3ControlVsCommitted.high.toFixed(2)}x the committed range.`,
    "## Dataset validation (V1/V2/V3)",
    table(
      ["dataset", "tables+indexes (C0 state)", "problems"],
      result.datasets.map((d) => [
        d.key,
        `${(d.sizeBytes / 1048576).toFixed(0)} MB`,
        d.problems.join("; ") || "none",
      ]),
    ),
    "Expected counts come from the seed's class map; the database counts are compared with them above. Whether a dataset fits in `shared_buffers` is not assumed: see the hit/read figures per run.",
    "```json",
    JSON.stringify(
      result.datasets.map(({ key, clusters, counts }) => ({ key, clusters, counts })),
      null,
      2,
    ),
    "```",
  ];
  for (const d of result.datasets)
    out.push(`## ${d.key}: execution time (median of timed runs)`, clusteredMatrix(result, d));
  out.push(
    "## Candidate accounting, C3: plan E/R1/Q/R2/O against the oracle E/R1/Q/R2/O",
    "E examined by the version scan, R1 rejected before the lateral lookup, Q reached it, R2 rejected after it, O returned. Compared only where the plan shape supports it.",
    table(["run", "plan", "oracle", "mismatches"], accountingRows(result)),
    "## Limits",
    "- Warm runs after a warm-up; cold-cache behaviour, write cost, index-maintenance cost, HOT behaviour and lock duration are not measured.",
    "- One dataset family, one PostgreSQL build, one tmpfs container, no concurrent writes, no `lockOrphan`.",
    "- A repeated run (noise, or C3 within 20% over its budget) is decided by the repeat; the earlier median is in `clustered-results.json`. P4/P5 NEAR is not repeated automatically.",
    "- The plans file holds raw EXPLAIN for every C3 run, one deep entry per dataset for the other configs, and any invalid run or failing plan shape; each is marked comparable, not comparable or timeout.",
    "## Cleanup",
    "```json",
    JSON.stringify(result.cleanup, null, 2),
    "```",
  );
  return `${out.join("\n\n")}\n`;
}
