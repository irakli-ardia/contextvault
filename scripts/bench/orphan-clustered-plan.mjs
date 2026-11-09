// Pure definitions of the clustered-backlog benchmark: datasets, scenarios, the measurement matrix
// and the expected synthetic class counts. Nothing here touches a database, so the expected
// counts are what the seed is meant to produce; only a run can show what it did produce.

const round5 = (x) => Math.round(x / 5) * 5;

/** Cluster windows are rank ranges [lo, hi) among waiting rows; F = front, D = deep, W = wide. */
export function datasets(waiting) {
  const win = (name, from, to, kind) => ({
    name,
    lo: round5(waiting * from),
    hi: round5(waiting * to),
    kind,
  });
  const twin = (kind) => [win("F", 0, 0.1, kind), win("D", 0.55, 0.65, kind)];
  return [
    { key: "control", clusters: [] },
    { key: "live", clusters: twin("live") },
    { key: "cooldown", clusters: twin("cooldown") },
    { key: "mixed", clusters: twin("mixed") },
    { key: "wide", clusters: [win("W", 0.05, 0.8, "mixed")] },
  ];
}

// `at` is the rank of the last row BEFORE the page (the cursor row); null means page 1.
const at = (rank) => (rank > 0 ? Math.round(rank) : null);

/** Scenarios of one dataset. Incomplete pages are only ever the control's `tail`. */
export function scenariosOf({ clusters }, waiting, page) {
  if (clusters.length === 0) {
    return [
      { key: "page-1", at: null, complete: true },
      { key: "mid-50", at: at(waiting / 2), complete: true },
      { key: "tail", at: at(waiting - 0.3 * page), complete: false },
    ];
  }
  return clusters.flatMap(({ name, lo, hi }) => [
    { key: `${name}-entry`, at: at(lo - 0.5 * page), complete: true },
    { key: `${name}-interior`, at: at((lo + hi) / 2), complete: true },
    { key: `${name}-exit`, at: at(hi - 0.2 * page), complete: true },
    { key: `${name}-beyond`, at: at(hi + 4 * page), complete: true },
  ]);
}

export const CONFIGS = [
  { label: "C0", variant: "baseline", reduced: true },
  { label: "C1", variant: "A", reduced: true },
  { label: "C2", variant: "B-no-include", reduced: false },
  { label: "C3", variant: "A+B-no-include", reduced: false },
];

/** Reduced configs run the control and, per clustered dataset, only the last cluster's entry. */
export function inMatrix(config, dataset, scenario) {
  if (!config.reduced || dataset.clusters.length === 0) return true;
  return scenario.key === `${dataset.clusters.at(-1).name}-entry`;
}

/** Row class of the seed (orphan-seed.mjs) for row `i`: the replica that V2 checks the tables against. */
export function classOf(i, waiting, clusters) {
  if (i > waiting) return i % 100;
  const r = (i * 7919) % waiting;
  const cluster = clusters.find((k) => r >= k.lo && r < k.hi);
  if (!cluster) return i % 100;
  if (cluster.kind === "live") return 60;
  if (cluster.kind === "cooldown") return 75;
  return i % 2 === 0 ? 60 : 75;
}

const between = (c, lo, hi) => c >= lo && c <= hi;

function historyOf(i, c, isWaiting) {
  if (!isWaiting) return 1;
  if (between(c, 75, 84)) return 8;
  if (c >= 96) return 12 + (i % 3);
  if (between(c, 60, 74)) return 1 + (i % 2);
  return 1 + (i % 3);
}

const CLASS_COUNTS = {
  with_live_outbox: (f) => f.live,
  attempts_exhausted: (f) => between(f.c, 92, 95),
  in_cooldown: (f) => between(f.c, 75, 84),
  deleted_document: (f) => between(f.c, 85, 91),
  history_ge_11: (f) => f.history >= 11,
};

/** Expected counts keyed like `countScenarios` (orphan-seed.mjs), derived from `i` alone. */
export function expectedCounts(waiting, clusters) {
  const total = waiting + Math.round(waiting * 0.325);
  const out = { waiting, max_history: 0, documents: total, versions: total, outbox_rows: 0 };
  for (const key of Object.keys(CLASS_COUNTS)) out[key] = 0;
  const workspaces = new Set();
  for (let i = 1; i <= total; i += 1) {
    const isWaiting = i <= waiting;
    const c = classOf(i, waiting, clusters);
    const live = isWaiting && between(c, 60, 74);
    const history = historyOf(i, c, isWaiting) + (live ? 1 : 0);
    out.outbox_rows += history;
    if (!isWaiting) continue;
    workspaces.add(Math.floor(i / 100) % 20);
    out.max_history = Math.max(out.max_history, history);
    for (const [key, test] of Object.entries(CLASS_COUNTS))
      out[key] += test({ c, live, history }) ? 1 : 0;
  }
  return { ...out, workspaces: workspaces.size };
}
