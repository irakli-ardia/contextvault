// The scenarios of a run and how the concurrency levels are compared fairly. Scenarios share one
// growing database, so the three levels are run in rounds whose order rotates: over a whole number
// of rotations every level takes every position equally often, and all levels get identical documents.

import { CLASSES, documentText, MIX, SMOKE_CLASSES } from "./ingestion-bench-corpus.mjs";
import { summary } from "./ingestion-bench-probe.mjs";

export const LEVELS = [1, 2, 4];
export const ROTATIONS = [
  [1, 2, 4],
  [2, 4, 1],
  [4, 1, 2],
];

export const classesOf = (smoke) => (smoke ? SMOKE_CLASSES : CLASSES);
const burstOf = (smoke) => (smoke ? 4 : 20);
/** Documents per class in the mixed workspace; the plan text and the scenario both read this. */
export const mixOf = (smoke) =>
  Object.fromEntries(Object.entries(MIX).map(([cls, n]) => [cls, smoke ? Math.ceil(n / 5) : n]));

export function plan({ smoke, repeats, rounds, serverStats }) {
  const classes = classesOf(smoke);
  const lines = [
    `sequential, concurrency 1, ${repeats}x each of ${Object.keys(classes).join("/")} (after one discarded warm-up)`,
    "one document of exactly parseLimits.maxInputBytes (rejected by the parser: shows the real chunk ceiling)",
    `${burstOf(smoke)} maximum-size documents at concurrency 1, 2 (the default) and 4: ${rounds} rounds, level order rotated per round, identical documents`,
    `one workspace of ${Object.values(mixOf(smoke)).reduce((a, b) => a + b)} mixed documents at concurrency 2`,
  ];
  if (!serverStats) return lines;
  return [
    ...lines,
    "server statistics: pg_stat_statements and lock-wait logging in this run's own container, read as its bootstrap superuser over the container socket after identity checks; reset and read around each scenario",
  ];
}

export function scenarios({ smoke, repeats, rounds, inputLimit }) {
  const classes = classesOf(smoke);
  let seed = 0;
  const docs = (cls, n) =>
    Array.from({ length: n }, () => {
      seed += 1;
      return { cls, text: documentText(seed, classes[cls]) };
    });
  const burst = docs("max", burstOf(smoke));
  const comparison = Array.from({ length: rounds }, (_, round) =>
    ROTATIONS[round % ROTATIONS.length].map((concurrency, at) => ({
      name: `burst-${burst.length}-max-c${concurrency}-r${round + 1}`,
      group: "concurrency",
      round: round + 1,
      position: at + 1,
      concurrency,
      docs: burst,
    })),
  ).flat();
  return [
    { name: "warm-up", concurrency: 1, sequential: true, docs: docs("small", 1), discard: true },
    ...Object.keys(classes).map((cls) => ({
      name: `sequential-${cls}`,
      concurrency: 1,
      sequential: true,
      docs: docs(cls, repeats),
    })),
    {
      name: "oversize-input",
      concurrency: 1,
      sequential: true,
      docs: [{ cls: "input-limit", expect: "rejected", text: documentText(99, inputLimit) }],
    },
    ...comparison,
    {
      name: "workspace-mixed-c2",
      concurrency: 2,
      docs: Object.entries(mixOf(smoke)).flatMap(([cls, n]) => docs(cls, n)),
    },
  ];
}

/**
 * Per-level summary over the rounds. `fair` is false unless every scenario completed all its jobs,
 * every level has the same number of rounds, and every level took the same set of positions.
 */
export function compareConcurrency(results) {
  const rows = results.filter((r) => r.group === "concurrency");
  const byLevel = Object.groupBy(rows, (r) => r.concurrency);
  const level = (n) => {
    const list = byLevel[n] ?? [];
    return {
      rounds: list.length,
      positions: list.map((r) => r.position),
      startingChunks: list.map((r) => r.countsBefore?.chunks ?? null),
      docsPerMinute: summary(list.map((r) => r.docsPerMinute)),
      wallMs: summary(list.map((r) => r.wallMs)),
      endToEndMedianMs: summary(
        list.map((r) => r.summary.max?.endToEndMs?.median).filter(Number.isFinite),
      ),
      allComplete: list.length > 0 && list.every((r) => r.completed === r.jobs),
      saturated: [...new Set(list.flatMap((r) => r.load?.saturated ?? []))],
    };
  };
  const levels = Object.fromEntries(LEVELS.map((n) => [n, level(n)]));
  const base = levels[1].docsPerMinute.median;
  return {
    levels,
    throughputVsConcurrency1: Object.fromEntries(
      LEVELS.map((n) => [n, base ? levels[n].docsPerMinute.median / base : null]),
    ),
    fair:
      LEVELS.every((n) => levels[n].allComplete && levels[n].rounds === levels[1].rounds) &&
      new Set(LEVELS.map((n) => levels[n].positions.toSorted((a, b) => a - b).join())).size === 1,
  };
}
