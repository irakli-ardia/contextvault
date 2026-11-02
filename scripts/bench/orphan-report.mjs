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
