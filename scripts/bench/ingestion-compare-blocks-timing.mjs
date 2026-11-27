// Idle gaps between the runs of a session, from the recorded timestamps only. They say nothing
// about CPU stability, power or host health. Limits are the PROPOSED ones, passed in by the caller.

const note = (code, detail) => ({ code, detail });

function gapKind(prev, r, latest, limits) {
  if (prev.endMs === null || latest === null) return "unknown";
  const seconds = (r.startMs - latest) / 1000;
  if (seconds < 0 || r.startMs === prev.startMs) return "overlap";
  if (seconds < limits.min) return "short";
  return seconds > limits.max ? "long" : "ok";
}

/** Idle time before each run, against the latest end so far, so a long run cannot hide overlaps. */
export function idleGaps(placed, limits) {
  const gaps = [];
  let latest = null;
  placed.forEach((r, i) => {
    const prev = placed[i - 1];
    const kind = prev ? gapKind(prev, r, latest, limits) : null;
    if (kind) {
      const seconds = kind === "unknown" ? null : (r.startMs - latest) / 1000;
      gaps.push({ before: prev.slot, after: r.slot, seconds, kind });
    }
    if (r.endMs !== null) latest = Math.max(latest ?? r.endMs, r.endMs);
  });
  return gaps;
}

const gapRules = (limits) => ({
  overlap: ["failures", "overlapping-runs", "runs overlap or start together"],
  short: ["warnings", "short-idle-gap", `idle gap below the proposed ${limits.min} s`],
  long: ["warnings", "long-idle-gap", `idle gap above the proposed ${limits.max} s`],
});

export function gapNotes(gaps, limits) {
  const out = { failures: [], warnings: [] };
  for (const g of gaps) {
    const rule = gapRules(limits)[g.kind];
    if (rule)
      out[rule[0]].push(note(rule[1], `slots ${g.before}-${g.after}: ${rule[2]} (${g.seconds} s)`));
  }
  return out;
}
