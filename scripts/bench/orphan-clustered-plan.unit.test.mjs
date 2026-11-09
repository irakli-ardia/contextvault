import { describe, expect, it } from "vitest";
import {
  CONFIGS,
  classOf,
  datasets,
  expectedCounts,
  inMatrix,
  scenariosOf,
} from "./orphan-clustered-plan.mjs";
import { seed } from "./orphan-seed.mjs";

const N = 200_000;
const PAGE = 500;
const all = datasets(N);
const byKey = Object.fromEntries(all.map((d) => [d.key, d]));

describe("expected synthetic counts", () => {
  it("reproduce the committed control dataset (results.json) without clusters", () => {
    expect(expectedCounts(N, [])).toEqual({
      waiting: 200000,
      with_live_outbox: 30000,
      attempts_exhausted: 8000,
      in_cooldown: 20000,
      deleted_document: 14000,
      history_ge_11: 8000,
      max_history: 14,
      workspaces: 20,
      documents: 265000,
      versions: 265000,
      outbox_rows: 687002,
    });
  });

  it("turn every window row into live or cooldown and leave the rest of the class map alone", () => {
    for (const d of all.slice(1)) {
      const inWindow = (i) => {
        const r = (i * 7919) % N;
        return d.clusters.some((k) => r >= k.lo && r < k.hi);
      };
      const wrong = [];
      let inside = 0;
      for (let i = 1; i <= N; i += 1) {
        const c = classOf(i, N, d.clusters);
        if (inWindow(i)) inside += 1;
        if (inWindow(i) ? c !== 60 && c !== 75 : c !== i % 100) wrong.push(i);
      }
      expect(wrong).toEqual([]);
      expect(inside).toBe(d.clusters.reduce((n, k) => n + k.hi - k.lo, 0));
    }
  });

  it("move the live and cooldown totals by the window size and keep waiting fixed", () => {
    const control = expectedCounts(N, []);
    const live = expectedCounts(N, byKey.live.clusters);
    const cooldown = expectedCounts(N, byKey.cooldown.clusters);
    expect(live.with_live_outbox).toBeGreaterThanOrEqual(40_000);
    expect(live.in_cooldown).toBeLessThan(control.in_cooldown);
    expect(cooldown.in_cooldown).toBeGreaterThanOrEqual(40_000);
    expect(cooldown.with_live_outbox).toBeLessThan(control.with_live_outbox);
    expect(live.attempts_exhausted).toBeLessThan(control.attempts_exhausted);
    expect([live, cooldown].map((c) => c.waiting)).toEqual([N, N]);
  });

  it("split a mixed window between live and cooldown", () => {
    const mixed = expectedCounts(N, byKey.mixed.clusters);
    const control = expectedCounts(N, []);
    expect(mixed.with_live_outbox).toBeGreaterThan(control.with_live_outbox - 20_000);
    expect(mixed.with_live_outbox + mixed.in_cooldown).toBeGreaterThan(40_000);
  });
});

describe("datasets and scenarios", () => {
  it("use windows that are multiples of 5 and match the approved definitions", () => {
    expect(byKey.live.clusters.map((k) => [k.lo, k.hi])).toEqual([
      [0, 20000],
      [110000, 130000],
    ]);
    expect(byKey.wide.clusters.map((k) => [k.lo, k.hi])).toEqual([[10000, 160000]]);
    for (const k of all.flatMap((d) => d.clusters)) expect([k.lo % 5, k.hi % 5]).toEqual([0, 0]);
  });

  it("total 31 scenarios, of which only the control tail is incomplete", () => {
    const scenarios = all.flatMap((d) => scenariosOf(d, N, PAGE).map((s) => ({ d: d.key, ...s })));
    expect(scenarios).toHaveLength(31);
    expect(scenarios.filter((s) => !s.complete).map((s) => `${s.d}/${s.key}`)).toEqual([
      "control/tail",
    ]);
    expect(scenariosOf(byKey.live, N, PAGE)).toHaveLength(8);
    expect(scenariosOf(byKey.wide, N, PAGE)).toHaveLength(4);
  });

  it("place cursors at entry, interior, exit and beyond each cluster", () => {
    const at = Object.fromEntries(scenariosOf(byKey.live, N, PAGE).map((s) => [s.key, s.at]));
    expect(at).toEqual({
      "F-entry": null,
      "F-interior": 10000,
      "F-exit": 19900,
      "F-beyond": 22000,
      "D-entry": 109750,
      "D-interior": 120000,
      "D-exit": 129900,
      "D-beyond": 132000,
    });
    const control = Object.fromEntries(
      scenariosOf(byKey.control, N, PAGE).map((s) => [s.key, s.at]),
    );
    expect(control).toEqual({ "page-1": null, "mid-50": 100000, tail: 199850 });
  });

  it("scale to the smoke size with windows still multiples of 5", () => {
    for (const k of datasets(5000).flatMap((d) => d.clusters))
      expect([k.lo % 5, k.hi % 5]).toEqual([0, 0]);
    expect(datasets(5000)[4].clusters[0]).toMatchObject({ lo: 250, hi: 4000 });
  });
});

describe("measurement matrix", () => {
  it("runs C2 and C3 everywhere and C0/C1 on the control plus one deep entry per clustered dataset", () => {
    const runs = (label) => {
      const config = CONFIGS.find((c) => c.label === label);
      return all.flatMap((d) => scenariosOf(d, N, PAGE).filter((s) => inMatrix(config, d, s)));
    };
    expect([runs("C0").length, runs("C1").length, runs("C2").length, runs("C3").length]).toEqual([
      7, 7, 31, 31,
    ]);
    expect(runs("C0").map((s) => s.key)).toEqual([
      "page-1",
      "mid-50",
      "tail",
      "D-entry",
      "D-entry",
      "D-entry",
      "W-entry",
    ]);
  });
});

describe("seed clusters", () => {
  const capture = async (clusters) => {
    let sql = "";
    await seed(
      {
        query: async (q) => {
          sql = q;
        },
      },
      N,
      clusters,
    );
    return sql;
  };
  it("override the class only inside the rank windows", async () => {
    const sql = await capture([{ lo: 0, hi: 20000, kind: "live" }]);
    expect(sql).toContain("select i, case when i <= 200000");
    expect(sql).toContain(
      ">= 0\n        and ((i::bigint * 7919) % 200000)::int < 20000 then 60 else i % 100 end",
    );
  });
  it("keep the original class expression without clusters", async () => {
    expect(await capture([])).toContain("select i, i % 100 as c, (i / 100)");
  });
  it.each([
    [{ lo: 1, hi: 10, kind: "live" }],
    [{ lo: 0, hi: 7, kind: "live" }],
    [{ lo: 0, hi: 10, kind: "other" }],
    [{ lo: 10, hi: 5, kind: "live" }],
    [{ lo: 0, hi: 200005, kind: "live" }],
  ])("reject the invalid window %j", async (cluster) => {
    await expect(capture([cluster])).rejects.toThrow(RangeError);
  });
  it("reject overlapping windows", async () => {
    await expect(
      capture([
        { lo: 0, hi: 10, kind: "live" },
        { lo: 5, hi: 15, kind: "live" },
      ]),
    ).rejects.toThrow(/overlap/);
  });
});
