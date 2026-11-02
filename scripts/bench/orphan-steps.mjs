// Steps of the orphan-discovery benchmark: index variants, keyset cursors and the lock statements.

import { executor, explainLock, summarize } from "./orphan-explain.mjs";

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const LOCK_CLASSES = [10, 50, 62, 80, 88, 94, 97, 99];
export const PAGE = 500;

const A =
  "create index bench_a on document_versions (updated_at, id) where status in ('uploaded', 'queued')";
const AI = `create index bench_a_inc on document_versions (updated_at, id)
  include (workspace_id, attempt) where status in ('uploaded', 'queued')`;
const B = "create index bench_b on outbox (workspace_id, version_id) include (dispatched_at)";
const BN = "create index bench_bn on outbox (workspace_id, version_id)";
export const VARIANTS = [
  { key: "baseline", ddl: [] },
  { key: "A", ddl: [A] },
  { key: "B", ddl: [B] },
  { key: "A+B", ddl: [A, B] },
  { key: "A-include", ddl: [AI] },
  { key: "A-include+B", ddl: [AI, B] },
  { key: "B-no-include", ddl: [BN] },
  { key: "A+B-no-include", ddl: [A, BN] },
];

export async function setVariant(owner, variant) {
  await owner.query("drop index if exists bench_a, bench_a_inc, bench_b, bench_bn");
  const built = [];
  for (const ddl of variant.ddl) {
    const started = performance.now();
    await owner.query(ddl);
    built.push({ ddl: ddl.replace(/\s+/g, " "), buildMs: Math.round(performance.now() - started) });
  }
  await owner.query("analyze document_versions; analyze outbox");
  const { rows } = await owner.query(
    `select indexrelid::regclass::text as name, pg_relation_size(indexrelid) as bytes
     from pg_index where indexrelid::regclass::text like 'bench\\_%'`,
  );
  return { built, sizes: Object.fromEntries(rows.map((r) => [r.name, Number(r.bytes)])) };
}

// Walks every page with the production source on the real data (A+B built only for speed; the
// result set does not depend on indexes) and returns the keyset cursor after ~50/90/99% of it.
export async function pickCursors(prod, admin) {
  const source = prod.createOrphanSource(executor(prod, admin));
  const cursors = [];
  let after;
  for (;;) {
    const rows = await source.listWaiting(PAGE, after);
    if (rows.length === PAGE) cursors.push(rows[PAGE - 1].cursor);
    if (rows.length < PAGE) return { cursors, eligible: cursors.length * PAGE + rows.length };
    after = rows[PAGE - 1].cursor;
  }
}

export async function lockSamples(admin) {
  const ids = LOCK_CLASSES.flatMap((c) => [1000, 1001].map((k) => k * 100 + c));
  const { rows } = await admin.query(
    `select md5('ver' || i)::uuid as version_id, md5('ws' || (i / 100) % 20)::uuid as workspace_id, i % 100 as class
     from unnest($1::int[]) i`,
    [ids],
  );
  return rows;
}

export async function measureLock(prod, client, samples) {
  const pass = async () => {
    const out = [];
    for (const s of samples) {
      await client.query("begin");
      try {
        await client.query("select set_config('app.workspace_id', $1, true)", [s.workspace_id]);
        out.push({
          class: s.class,
          plans: await explainLock(prod, client, s.workspace_id, s.version_id),
        });
      } finally {
        await client.query("rollback");
      }
    }
    return out;
  };
  await pass();
  const passes = [await pass(), await pass(), await pass()].flat();
  const stat = (index) => {
    const times = passes.map((p) => p.plans[index]["Execution Time"]);
    return { medianMs: median(times), maxMs: Math.max(...times) };
  };
  return { statements: [stat(0), stat(1)], second: summarize(passes[0].plans[1]) };
}
