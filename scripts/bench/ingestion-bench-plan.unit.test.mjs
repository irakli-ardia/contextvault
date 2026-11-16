import { describe, expect, it } from "vitest";
import {
  compareConcurrency,
  LEVELS,
  mixOf,
  plan,
  ROTATIONS,
  scenarios,
} from "./ingestion-bench-plan.mjs";

const opts = { smoke: true, repeats: 2, rounds: 3, inputLimit: 5000 };
const comparison = (o = opts) => scenarios(o).filter((s) => s.group === "concurrency");

describe("scenarios", () => {
  it("puts every level in every position equally often over whole rotations", () => {
    for (const rounds of [3, 6]) {
      const list = comparison({ ...opts, rounds });
      expect(list).toHaveLength(rounds * 3);
      for (const level of LEVELS) {
        const positions = list.filter((s) => s.concurrency === level).map((s) => s.position);
        for (const p of [1, 2, 3])
          expect(positions.filter((x) => x === p)).toHaveLength(rounds / 3);
      }
    }
    expect(ROTATIONS.every((r) => [...r].sort((a, b) => a - b).join() === "1,2,4")).toBe(true);
  });
  it("gives every level the identical documents and unique scenario names", () => {
    const list = comparison();
    expect(new Set(list.map((s) => s.docs)).size).toBe(1);
    expect(new Set(list.map((s) => s.name)).size).toBe(list.length);
  });
  it("keeps the warm-up discarded, the oversize document expected to be rejected, and sequential repeats", () => {
    const all = scenarios(opts);
    expect(all[0]).toMatchObject({ name: "warm-up", discard: true });
    expect(all.find((s) => s.name === "oversize-input").docs[0]).toMatchObject({
      expect: "rejected",
    });
    expect(all.find((s) => s.name === "sequential-small").docs).toHaveLength(2);
  });
  it("describes the plan with the rounds", () => {
    expect(plan(opts).join("\n")).toMatch(/3 rounds, level order rotated/);
  });
});

const result = (concurrency, position, docsPerMinute, over = {}) => ({
  group: "concurrency",
  concurrency,
  position,
  docsPerMinute,
  wallMs: 60_000 / docsPerMinute,
  jobs: 4,
  completed: 4,
  countsBefore: { chunks: 100 * position },
  summary: { max: { endToEndMs: { median: 1000 / docsPerMinute } } },
  load: { saturated: [] },
  ...over,
});
const balanced = (rates) => LEVELS.flatMap((c) => [1, 2, 3].map((p) => result(c, p, rates[c])));

describe("compareConcurrency", () => {
  it("summarizes each level over its rounds and the throughput relative to concurrency 1", () => {
    const c = compareConcurrency(balanced({ 1: 10, 2: 15, 4: 20 }));
    expect(c.fair).toBe(true);
    expect(c.levels[2]).toMatchObject({
      rounds: 3,
      allComplete: true,
      positions: [1, 2, 3],
      startingChunks: [100, 200, 300],
    });
    expect(c.levels[4].docsPerMinute).toMatchObject({ n: 3, median: 20 });
    expect(c.throughputVsConcurrency1).toEqual({ 1: 1, 2: 1.5, 4: 2 });
  });
  it("is not fair when a scenario lost a job, positions differ, or rounds are uneven", () => {
    const lost = balanced({ 1: 10, 2: 15, 4: 20 });
    lost[4].completed = 3;
    expect(compareConcurrency(lost).fair).toBe(false);
    const skewed = balanced({ 1: 10, 2: 15, 4: 20 }).map((r) =>
      r.concurrency === 4 ? { ...r, position: 3 } : r,
    );
    expect(compareConcurrency(skewed).fair).toBe(false);
    expect(compareConcurrency(balanced({ 1: 10, 2: 15, 4: 20 }).slice(1)).fair).toBe(false);
  });
  it("reports saturation seen at any round and tolerates no comparison results", () => {
    const rows = balanced({ 1: 10, 2: 15, 4: 20 });
    rows[0].load = { saturated: ["worker-cpu"] };
    expect(compareConcurrency(rows).levels[1].saturated).toEqual(["worker-cpu"]);
    expect(compareConcurrency([]).fair).toBe(false);
  });
});

describe("plan accuracy", () => {
  const stated = (o) => Number(/workspace of (\d+) mixed/.exec(plan(o).join("\n"))?.[1]);
  const total = (smoke) => Object.values(mixOf(smoke)).reduce((a, b) => a + b);
  it("states the document count the smoke mixed scenario really generates", () => {
    const generated = scenarios(opts).find((s) => s.name === "workspace-mixed-c2").docs.length;
    expect(generated).toBe(11);
    expect(stated(opts)).toBe(generated);
  });
  it("states the full-size count from the same mix (not generated: its documents are megabytes)", () => {
    expect(stated({ ...opts, smoke: false })).toBe(50);
    expect(total(false)).toBe(50);
  });
});
