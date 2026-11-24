// The two optional measurement inputs of a result: PostgreSQL statement statistics and the c1
// embedding control values. Both only describe what was recorded. A server-data problem never
// fails a run (client timings stay valid), and no threshold or exclusion is decided here.

import { CHECKED } from "./ingestion-bench-server-stats-rules.mjs";
import { isRecord } from "./ingestion-compare-provenance.mjs";

const finite = (v) => typeof v === "number" && Number.isFinite(v);
/** Text for a diagnostic: untrusted values are never stringified, so no `toString` can run. */
export function shown(v) {
  if (typeof v === "string") return v.slice(0, 80);
  return finite(v) || typeof v === "boolean" ? String(v) : typeof v;
}
export const failure = (code, detail) => ({ code, detail: shown(detail).slice(0, 200) });

/** The concurrency-1 maximum-size scenarios whose embedding time is the host-load control. */
export const CONTROL_SCENARIOS = [
  "sequential-max",
  "burst-20-max-c1-r1",
  "burst-20-max-c1-r2",
  "burst-20-max-c1-r3",
];

function lockWaitsOk(w) {
  return isRecord(w) && ["count", "totalMs", "maxMs"].every((k) => finite(w[k]) && w[k] >= 0);
}

const deallocationReason = (n) => {
  if (n === 0) return [];
  return [finite(n) ? `deallocations: ${n}` : "deallocations malformed"];
};

const reasonsOf = (data, missingClasses) => {
  const own = Array.isArray(data.invalidReasons)
    ? data.invalidReasons.filter((r) => typeof r === "string").map(shown)
    : [];
  return [
    ...own,
    ...(data.valid !== true && own.length === 0 ? ["marked invalid"] : []),
    ...deallocationReason(data.deallocations),
    ...(lockWaitsOk(data.lockWaits) ? [] : ["lock waits malformed"]),
    ...(missingClasses.length > 0 ? [`missing classes: ${missingClasses.join(", ")}`] : []),
  ];
};

const wellFormed = (d) => isRecord(d) && typeof d.valid === "boolean" && isRecord(d.classes);

const figures = (data, reasons, missingClasses) => ({
  status: reasons.length === 0 ? "valid" : "invalid",
  reasons,
  deallocations: finite(data.deallocations) ? data.deallocations : null,
  missingClasses,
  lockWaits: lockWaitsOk(data.lockWaits) ? data.lockWaits : null,
});

/** One scenario's server data: `missing`, `invalid` (with reasons) or `valid`. */
function serverScenario(s) {
  const data = s.serverStatements;
  if (data === undefined || data === null) return { status: "missing", reasons: [] };
  if (!wellFormed(data)) return { status: "invalid", reasons: ["malformed serverStatements"] };
  const expected = s.activationTransactions > 0 ? CHECKED : [];
  const missingClasses = expected.filter(
    (c) => !(finite(data.classes[c]?.calls) && data.classes[c].calls > 0),
  );
  return figures(data, reasonsOf(data, missingClasses), missingClasses);
}

export function checkServer(r) {
  const enabled = r.config?.serverStats === true;
  const scenarios = Array.isArray(r.scenarios) ? r.scenarios.filter(isRecord) : [];
  if (!enabled) {
    const stray = scenarios.some((s) => s.serverStatements !== undefined);
    return { enabled, scenarios: {}, issues: stray ? ["server data without the flag"] : [] };
  }
  const issues =
    r.serverStats?.enabled === true && r.serverStats.containerIdentityVerified === true
      ? []
      : ["server statistics metadata missing or unverified"];
  return {
    enabled,
    scenarios: Object.fromEntries(scenarios.map((s) => [shown(s.name), serverScenario(s)])),
    issues,
  };
}

export function checkControls(r) {
  const controls = {};
  const out = [];
  for (const name of CONTROL_SCENARIOS) {
    const found = Array.isArray(r.scenarios)
      ? r.scenarios.find((s) => s?.name === name)
      : undefined;
    const stat = found?.summary?.max?.embedMs;
    if (!isRecord(stat)) out.push(failure("control-missing", name));
    else if (!finite(stat.median) || stat.median < 0 || !Number.isInteger(stat.n) || stat.n < 1)
      out.push(failure("control-invalid", name));
    else controls[name] = { embedMedianMs: stat.median, n: stat.n };
  }
  return { controls, failures: out };
}
