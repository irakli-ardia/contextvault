// Synthetic sessions for the block grouping tests: real harness results (`makeRun`) loaded through
// the real loader, with start and end times laid out on a fixed clock. Nothing here is a measurement.

import { changed, makeRun } from "./ingestion-compare-fixtures.mjs";
import { loadText } from "./ingestion-compare-load.mjs";
import { clean } from "./ingestion-compare-outcomes-fixtures.mjs";
import { CONTROL_SCENARIOS } from "./ingestion-compare-server.mjs";

export const FULL = "ABBABAABABBABAABABBA";
const ARMS = { A: "baseline", B: "stored-tsv" };
const DURATION_MS = 540_000;
const BASE = Date.UTC(2026, 10, 20, 9, 0, 0);

/** One run of `label` (A or B) at slot `index`, started `gapSeconds` after the previous ended. */
export function sessionRun(label, index, { gapSeconds = 300, edit } = {}) {
  const start = BASE + index * (DURATION_MS + gapSeconds * 1000);
  const run = changed(makeRun({ arm: ARMS[label], index, serverStats: false }), (r) => {
    r.scenarios = CONTROL_SCENARIOS.map(clean);
    r.startedAt = new Date(start).toISOString();
    r.completedAt = new Date(start + DURATION_MS).toISOString();
    edit?.(r);
  });
  return run;
}

export const asEntry = (run, index) => loadText(`run${index}.json`, JSON.stringify(run));

/** Loader entries for a session whose arms follow `labels`, e.g. "ABBABAABABBA". */
export function session(labels = FULL.slice(0, 12), options = {}) {
  return labels.split("").map((l, i) => asEntry(sessionRun(l, i, options), i));
}

/** The session with the run at `slot` (0-based) edited, or replaced by `edit`'s result. */
export function sessionWith(labels, slot, edit, options = {}) {
  return labels
    .split("")
    .map((l, i) =>
      asEntry(sessionRun(l, i, { ...options, edit: i === slot ? edit : undefined }), i),
    );
}
