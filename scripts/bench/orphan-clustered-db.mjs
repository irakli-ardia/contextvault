// Database side of the clustered benchmark's validation: cursors by rank, the independent oracle
// over the tables, and the V2/V3 preparation of a scenario. Privileged reads only, on the disposable
// container; the measured statements live elsewhere and are the production ones.

import { checkPage, windowProblems } from "./orphan-clustered-checks.mjs";
import { executor } from "./orphan-explain.mjs";

const WAITING_SQL = "dv.status in ('uploaded', 'queued')";

/** The cursor row at 0-based `rank` among waiting versions, in the production text format. */
export async function cursorAt(admin, rank) {
  if (rank === null) return undefined;
  const { rows } = await admin.query(
    `select updated_at::text || '|' || id as cursor from document_versions dv
     where ${WAITING_SQL} order by updated_at, id offset $1 limit 1`,
    [rank],
  );
  return rows[0].cursor;
}

// Independent oracle over the tables, not the plan: waiting versions after `after` up to `until`
// (open-ended when undefined). Live = an undispatched outbox row exists; cooling = idle time below
// the cooldown (the production formula repeated only to count, like countScenarios; it never picks
// what is measured). The outbox lookup is by (workspace_id, version_id) to use the measured index.
async function oracle(admin, after, until) {
  const [at, id] = after?.split("|") ?? [null, null];
  const [toAt, toId] = until?.split("|") ?? [null, null];
  const { rows } = await admin.query(
    `select count(*)::int as e, count(*) filter (where attempt >= 3)::int as r1,
       count(*) filter (where attempt < 3)::int as q,
       count(*) filter (where attempt < 3 and live)::int as live,
       count(*) filter (where attempt < 3 and not live and idle_ms < cooldown_ms)::int as cooling,
       count(*) filter (where deleted)::int as deleted
     from (
       select dv.attempt, d.deleted_at is not null as deleted, h.live,
         extract(epoch from now() - greatest(dv.updated_at, h.last_dispatched)) * 1000 as idle_ms,
         least(21600000::float8, 300000::float8
           * power(2, greatest(0, least(h.total, 11) - 1 - dv.attempt))) as cooldown_ms
       from document_versions dv join documents d on d.id = dv.document_id
         cross join lateral (
           select count(*) as total, coalesce(bool_or(o.dispatched_at is null), false) as live,
             max(o.dispatched_at) as last_dispatched
           from outbox o where o.workspace_id = dv.workspace_id and o.version_id = dv.id) h
       where ${WAITING_SQL}
         and ($1::timestamptz is null or (dv.updated_at, dv.id) > ($1::timestamptz, $2::uuid))
         and ($3::timestamptz is null or (dv.updated_at, dv.id) <= ($3::timestamptz, $4::uuid))) x`,
    [at, id, toAt, toId],
  );
  const o = rows[0];
  return { ...o, r2: o.live + o.cooling, o: o.q - o.live - o.cooling };
}

async function ranksOf(admin, ids) {
  const { rows } = await admin.query(
    `select id, rn from (select id, row_number() over (order by updated_at, id) - 1 as rn
       from document_versions dv where ${WAITING_SQL}) x where id = any($1::uuid[])`,
    [ids],
  );
  return new Map(rows.map((r) => [r.id, Number(r.rn)]));
}

/** V3: runs the scenario's page once with the production source as the worker and checks it. */
export async function prepare({ prod, admin, worker }, dataset, sc, page) {
  const after = await cursorAt(admin, sc.at);
  const rows = await prod.createOrphanSource(executor(prod, worker)).listWaiting(page, after);
  const until = sc.complete ? rows.at(-1)?.cursor : undefined;
  const orc = await oracle(admin, after, until);
  const ranks = await ranksOf(
    admin,
    rows.map((r) => r.versionId),
  );
  const problems = checkPage({
    ...{ rows, ranks, limit: page, complete: sc.complete, oracle: orc },
    ...{ afterRank: sc.at ?? -1, windows: dataset.clusters },
  });
  return { ...sc, after, oracle: orc, problems };
}

/** V2 windows: the rank range [lo, hi) holds exactly the cluster's rows, via the oracle. */
export async function validateWindows(admin, clusters) {
  const out = [];
  for (const k of clusters) {
    const orc = await oracle(
      admin,
      await cursorAt(admin, k.lo > 0 ? k.lo - 1 : null),
      await cursorAt(admin, k.hi - 1),
    );
    out.push({ ...k, oracle: orc, problems: windowProblems(orc, k) });
  }
  return out;
}
