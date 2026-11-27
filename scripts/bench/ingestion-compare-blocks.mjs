// Offline session grouping and structural validation for the PROPOSED ABBA/BAAB comparison
// protocol. Pure: it takes loader entries (`loadDirectory().entries`), reads nothing and mutates
// nothing. The protocol below is a proposal, not the approved experiment (R12): the thresholds and
// the sequence are labeled as such, and nothing here decides when an optional block is run.
// "valid" means the session is structurally well formed: every entry loaded, the arms follow the
// proposed order, no duplicate or overlapping run, provenance identical. It says nothing about
// performance, block usability or statistics, and timestamp gaps say nothing about host health.
// Every input is kept in `runs`, in its slot if its start time is readable, else unplaced.
// Evidence limit: the harness records no session id and no run ordinal (`runId` is random,
// `experimentId` a fresh UUID per run), so a run that is absent from the input cannot be detected
// as such. Only what the observed runs show is checked: arm order, length, duplicates, timestamps,
// provenance. An observed 12, 16 or 20 run sequence can match the protocol even when runs of a
// longer intended session are missing (an order-preserving hole, or the first 12 runs of an
// intended 16). Detecting that needs an independent manifest, which is not part of this step.
// `groupSession` receives `loadDirectory().entries` only. The caller must also propagate that
// result's `errors` (unreadable directory, no files): they are not visible here.

import { gapNotes, idleGaps } from "./ingestion-compare-blocks-timing.mjs";
import { canonical, compareProvenance, isRecord } from "./ingestion-compare-provenance.mjs";
import { parseTime } from "./ingestion-compare-records.mjs";

/** PROPOSED, NOT APPROVED. A = baseline, B = stored-tsv; blocks 4 and 5 are optional. */
export const PROPOSED_PROTOCOL = Object.freeze({
  approved: false,
  arms: Object.freeze({ A: "baseline", B: "stored-tsv" }),
  sequence: Object.freeze(["ABBA", "BAAB", "ABBA", "BAAB", "ABBA"]),
  completeLengths: Object.freeze([12, 16, 20]),
  maxRuns: 20,
  idleGapSeconds: Object.freeze({ min: 120, max: 1800 }),
});

const P = PROPOSED_PROTOCOL;
const ARM_LABEL = new Map([
  ["baseline", "A"],
  ["stored-tsv", "B"],
]);
const note = (code, detail) => ({ code, detail });
const str = (v) => (typeof v === "string" ? v : null);
const where = (r) => r.file ?? "unnamed";
const order = (a, b) => (a > b) - (a < b);
const sortKey = (r) => [
  r.startMs,
  r.endMs ?? Number.POSITIVE_INFINITY,
  r.runId ?? "",
  r.sha256 ?? "",
  where(r),
];
const byTime = (a, b) => {
  const other = sortKey(b);
  return (
    sortKey(a)
      .map((v, i) => order(v, other[i]))
      .find((d) => d !== 0) ?? 0
  );
};

function describeEntry(raw) {
  const e = isRecord(raw) ? raw : {};
  const id = isRecord(e.identity) ? e.identity : {};
  return {
    file: str(e.file),
    sha256: str(e.sha256),
    runId: str(id.runId),
    experimentId: str(id.experimentId),
    startedAt: id.startedAt ?? null,
    completedAt: id.completedAt ?? null,
    startMs: parseTime(id.startedAt),
    endMs: parseTime(id.completedAt),
    arm: str(id.arm),
    label: ARM_LABEL.get(id.arm) ?? null,
    valid: e.valid === true,
    standing: e.standing ?? null,
    // Kept as given; `usableProvenance` decides whether it can be compared.
    failures: Array.isArray(e.failures) ? e.failures : [],
    provenance: e.provenance,
  };
}

function place(run, slot) {
  const expected = slot <= P.maxRuns ? P.sequence[(slot - 1) >> 2][(slot - 1) % 4] : null;
  const block = expected === null ? null : ((slot - 1) >> 2) + 1;
  return { ...run, slot, block, position: block === null ? null : ((slot - 1) % 4) + 1, expected };
}

const unplaced = (run) => ({ ...run, slot: null, block: null, position: null, expected: null });

function placementFailures(r) {
  const out = [];
  if (r.slot === null) out.push(note("unplaced-run", `${where(r)}: startedAt is not readable`));
  else if (r.endMs === null)
    out.push(note("invalid-timestamp", `${where(r)}: completedAt is not readable`));
  if (r.runId === null) out.push(note("missing-run-id", where(r)));
  if (r.slot !== null && r.expected === null)
    out.push(note("unexpected-run", `slot ${r.slot} ${where(r)}: beyond ${P.maxRuns} runs`));
  return out;
}

function armFailures(r) {
  if (r.label === null) return [note("unknown-arm", `${where(r)}: arm is ${r.arm ?? "absent"}`)];
  if (r.expected === null || r.label === r.expected) return [];
  return [note("arm-sequence", `slot ${r.slot}: expected ${r.expected}, found ${r.label}`)];
}

/** Only these two standings can pass; anything else, absent or malformed, fails closed. */
const ACCEPTED_STANDINGS = new Set(["valid", "outcome"]);

/** The loader's `valid` and the standing both count: neither can bypass the other. */
function standingNotes(r) {
  const standing = isRecord(r.standing) ? r.standing.standing : undefined;
  const accepted = typeof standing === "string" && ACCEPTED_STANDINGS.has(standing);
  if (!r.valid || !accepted) {
    const codes = r.failures.map((f) => str(f?.code) ?? "?").join(",");
    const shown = typeof standing === "string" ? standing : "malformed";
    return {
      failures: [note("run-invalid", `${where(r)}: loader failures [${codes}], standing ${shown}`)],
      warnings: [],
    };
  }
  return { failures: [], warnings: standing === "outcome" ? [note("run-outcome", where(r))] : [] };
}

/** Provenance `compareProvenance` can safely compare: an object that canonicalizes. */
function usableProvenance(r) {
  if (!isRecord(r.provenance)) return false;
  try {
    canonical(r.provenance);
    return true;
  } catch {
    return false;
  }
}

/** A run the loader accepted must carry comparable provenance; otherwise it is a failure. */
const provenanceNotes = (r) =>
  r.valid && !usableProvenance(r) ? [note("malformed-provenance", where(r))] : [];

function runNotes(r) {
  const standing = standingNotes(r);
  return {
    failures: [...placementFailures(r), ...armFailures(r), ...standing.failures],
    warnings: standing.warnings,
  };
}

function duplicates(runs, key, code) {
  return [
    ...Map.groupBy(
      runs.filter((r) => r[key] !== null),
      (r) => r[key],
    ),
  ]
    .filter(([, list]) => list.length > 1)
    .map(([id, list]) => note(code, `${id}: ${list.map(where).join(", ")}`));
}

function blocksOf(placed) {
  const groups = Map.groupBy(
    placed.filter((r) => r.block !== null),
    (r) => r.block,
  );
  return [...groups].map(([block, list]) => {
    const expected = P.sequence[block - 1];
    const actual = list.map((r) => r.label ?? "?").join("");
    return {
      block,
      expected,
      actual,
      slots: list.map((r) => r.slot),
      complete: list.length === expected.length,
      orientationOk: expected.startsWith(actual),
    };
  });
}

/**
 * `missingRuns` is only the distance from the observed count to the next supported length (0 if
 * supported), not a count of runs missing from an intended session: that is unknowable here.
 */
function completeness(count) {
  const next = P.completeLengths.find((n) => n >= count) ?? null;
  const partial = next !== null && next !== count;
  const detail = `${count} placed runs; complete sessions have ${P.completeLengths.join(", ")}`;
  return {
    incomplete: partial ? [note("incomplete-session", detail)] : [],
    missingRuns: partial ? next - count : 0,
  };
}

function structuralFailures(all, placed, gaps) {
  const provenance = compareProvenance(
    placed
      .filter((r) => r.valid && usableProvenance(r))
      .map((r) => ({ file: r.file, provenance: r.provenance })),
  );
  const timing = gapNotes(gaps, P.idleGapSeconds);
  const notes = all.map(runNotes);
  return {
    provenance,
    warnings: [...notes.flatMap((n) => n.warnings), ...timing.warnings],
    failures: [
      ...notes.flatMap((n) => n.failures),
      ...all.flatMap(provenanceNotes),
      ...duplicates(all, "runId", "duplicate-run-id"),
      ...duplicates(all, "experimentId", "duplicate-experiment-id"),
      ...duplicates(all, "sha256", "duplicate-file-content"),
      ...timing.failures,
      ...provenance.mismatches.map((m) =>
        note("provenance-mismatch", `${m.file}: ${m.fields.join(", ")}`),
      ),
    ],
  };
}

/**
 * Groups loader entries into the proposed session and validates its structure.
 * `status` is `invalid` if any failure exists, else `incomplete` if the run count is not a
 * supported session length, else `valid`. A short tail shows as `incomplete`, and a missing run
 * that breaks the arm order shows as `invalid`; a missing run that leaves a supported length and
 * the proposed order intact is not detectable (see the evidence limit above).
 */
export function groupSession(entries) {
  const described = (Array.isArray(entries) ? entries : []).map(describeEntry);
  const timed = described.filter((r) => r.startMs !== null).sort(byTime);
  const placed = timed.map((r, i) => place(r, i + 1));
  const loose = described
    .filter((r) => r.startMs === null)
    .sort(byTime)
    .map(unplaced);
  const all = [...placed, ...loose];
  const gaps = idleGaps(placed, P.idleGapSeconds);
  const { provenance, failures, warnings } = structuralFailures(all, placed, gaps);
  const { incomplete, missingRuns } = completeness(placed.length);
  const strip = ({ provenance: _p, ...rest }) => rest;
  let status = "valid";
  if (failures.length > 0) status = "invalid";
  else if (incomplete.length > 0) status = "incomplete";
  return {
    protocol: P,
    status,
    runCount: all.length,
    missingRuns,
    runs: all.map(strip),
    blocks: blocksOf(placed),
    gaps,
    failures,
    warnings,
    incomplete,
    provenance,
  };
}
