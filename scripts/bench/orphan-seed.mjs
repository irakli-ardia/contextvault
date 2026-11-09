// Deterministic synthetic data for the orphan-discovery benchmark, loaded by the bootstrap
// superuser (RLS-exempt, like the fixture role) into the disposable database only. Everything is
// derived from the row number `i`, so a run reproduces the same shape; timestamps are relative to
// the load time because eligibility is relative to now().
//
// Waiting versions (uploaded/queued), class c = i % 100, workspace w = (i / 100) % 20:
//   0-59 eligible (1-3 dispatched entries, old)      60-74 one live outbox entry (ineligible)
//   75-84 inside cooldown (8 entries, last 2 min ago; cooldown caps at 6 h, so it holds all run)
//   85-91 deleted document (the source cannot see it, so it is still listed)
//   92-95 attempts exhausted (ineligible)            96-99 deep history (12-14 entries, eligible)
// `updated_at` is a bijective permutation of i (7919 is coprime with N = 200000), so heap order does
// not follow keyset order, as after real status churn; five rows share each timestamp (id tiebreak).
// Noise: 32.5% more versions that are not waiting (ready, parsing, failed), one entry each.
//
// Clusters (orphan-clustered.mjs) override the class of every waiting row whose r = i * 7919 mod N
// falls in [lo, hi): live -> 60, cooldown -> 75, mixed -> 60 for even i, else 75. Because five rows
// share each timestamp and r is a bijection, a window whose bounds are multiples of 5 covers whole
// timestamp groups, so it is exactly the waiting rows ranked lo..hi-1 in (updated_at, id) order.
// Exhausted and deleted rows therefore never occur inside a window, so their totals in a clustered
// dataset are lower than in the control (the window overrides them). No clusters: unchanged seed.

const WORKSPACES = 20;
const CLUSTER_CLASS = {
  live: "60",
  cooldown: "75",
  mixed: "case when i % 2 = 0 then 60 else 75 end",
};

function assertWindow({ lo, hi, kind }, waiting) {
  const aligned = Number.isInteger(lo) && Number.isInteger(hi) && lo % 5 === 0 && hi % 5 === 0;
  if (!aligned || lo < 0 || hi <= lo || hi > waiting || !(kind in CLUSTER_CLASS)) {
    throw new RangeError(
      "cluster must be a known kind with 0 <= lo < hi <= waiting, both multiples of 5",
    );
  }
}

function classExpression(waiting, clusters) {
  const sorted = [...clusters].sort((a, b) => a.lo - b.lo);
  for (const window of sorted) assertWindow(window, waiting);
  if (sorted.some((w, k) => k > 0 && w.lo < sorted[k - 1].hi)) {
    throw new RangeError("clusters must not overlap");
  }
  if (sorted.length > 0 && waiting % 5 !== 0)
    throw new RangeError("clusters need waiting % 5 === 0");
  const windows = sorted.map(
    ({ lo, hi, kind }) =>
      `when i <= ${waiting} and ((i::bigint * 7919) % ${waiting})::int >= ${lo}
        and ((i::bigint * 7919) % ${waiting})::int < ${hi} then ${CLUSTER_CLASS[kind]}`,
  );
  return windows.length === 0 ? "i % 100" : `case ${windows.join(" ")} else i % 100 end`;
}

export async function seed(admin, waiting, clusters = []) {
  if (!Number.isInteger(waiting) || waiting < 1000 || waiting > 200_000) {
    throw new RangeError("waiting must be an integer in 1000..200000");
  }
  const classOf = classExpression(waiting, clusters);
  const total = waiting + Math.round(waiting * 0.325);
  await admin.query(`
    begin;
    truncate outbox, document_versions, documents, workspaces, users cascade;
    insert into users (id, email) values (md5('user')::uuid, 'bench@bench.invalid');
    insert into workspaces (id, name, created_by)
      select md5('ws' || w)::uuid, 'ws' || w, md5('user')::uuid from generate_series(0, ${WORKSPACES - 1}) w;

    create temp table plan on commit drop as
    with t as (select now() as t0), base as (
      select i, ${classOf} as c, (i / 100) % ${WORKSPACES} as w, i <= ${waiting} as waiting,
        ((i::bigint * 7919) % ${waiting})::int as r
      from generate_series(1, ${total}) i)
    select b.i, b.c, b.w, b.waiting,
      case when b.waiting then (case when b.i % 2 = 0 then 'queued' else 'uploaded' end)
           when b.i % 13 = 0 then 'failed' when b.i % 7 = 0 then 'parsing' else 'ready' end as status,
      case when b.waiting and b.c between 92 and 95 then 3 + b.i % 2
           when b.waiting then b.i % 3 else 0 end as attempt,
      case when not b.waiting then 1 when b.c between 75 and 84 then 8
           when b.c >= 96 then 12 + b.i % 3 when b.c between 60 and 74 then 1 + b.i % 2
           else 1 + b.i % 3 end as h,
      b.waiting and b.c between 60 and 74 as live,
      b.waiting and b.c between 85 and 91 as deleted,
      b.waiting and b.c between 75 and 84 as cooling,
      t.t0, t.t0 - interval '60 days'
        + interval '58 days' * ((b.r / 5)::float8 / ${Math.floor(waiting / 5)}) as upd
    from base b cross join t;

    insert into documents (id, workspace_id, display_name, mime, size_bytes, content_sha256,
        deleted_at, created_by, created_at)
      select md5('doc' || i)::uuid, md5('ws' || w)::uuid, 'doc-' || i, 'text/plain', 1000,
        decode(md5('a' || i) || md5('b' || i), 'hex'),
        case when deleted then t0 - interval '1 day' end, md5('user')::uuid, upd - interval '1 day'
      from plan;
    insert into document_versions (id, document_id, workspace_id, version_no, storage_key, status,
        lease_generation, attempt, created_at, updated_at)
      select md5('ver' || i)::uuid, md5('doc' || i)::uuid, md5('ws' || w)::uuid, 1,
        'ws/' || md5('ws' || w)::uuid || '/doc/' || md5('doc' || i)::uuid || '/v/' || md5('ver' || i)::uuid,
        status, 0, attempt, upd - interval '1 hour', upd
      from plan;
    insert into outbox (id, workspace_id, version_id, kind, available_at, dispatched_at, created_at)
      select md5('ob' || i || '-' || k)::uuid, md5('ws' || w)::uuid, md5('ver' || i)::uuid,
        'process_version', d - interval '1 minute', d, d - interval '1 minute'
      from (select p.*, k, case when cooling then t0 - interval '2 minutes' - (k - 1) * interval '1 hour'
                                else upd - k * interval '1 hour' end as d
            from plan p cross join lateral generate_series(1, p.h) k) x;
    insert into outbox (id, workspace_id, version_id, kind, available_at, dispatched_at, created_at)
      select md5('ob' || i || '-live')::uuid, md5('ws' || w)::uuid, md5('ver' || i)::uuid,
        'process_version', upd + interval '1 hour', null, upd + interval '1 hour'
      from plan where live;
    commit;`);
}

// Row counts per scenario, from the tables themselves (the cooldown line repeats the production
// formula only to count; it is never used to pick what is measured).
export async function countScenarios(admin) {
  const { rows } = await admin.query(`
    with v as (
      select dv.id, dv.workspace_id, dv.attempt, dv.updated_at, d.deleted_at,
        count(o.id) as total, bool_or(o.dispatched_at is null) as live,
        max(o.dispatched_at) as last_dispatched
      from document_versions dv join documents d on d.id = dv.document_id
        left join outbox o on o.version_id = dv.id
      where dv.status in ('uploaded', 'queued') group by dv.id, d.deleted_at)
    select count(*)::int as waiting,
      count(*) filter (where live)::int as with_live_outbox,
      count(*) filter (where attempt >= 3)::int as attempts_exhausted,
      count(*) filter (where not live and attempt < 3 and extract(epoch from now()
        - greatest(updated_at, last_dispatched)) * 1000 < least(21600000::float8,
        300000::float8 * power(2, greatest(0, least(total, 11) - 1 - attempt))))::int as in_cooldown,
      count(*) filter (where deleted_at is not null)::int as deleted_document,
      count(*) filter (where total >= 11)::int as history_ge_11,
      max(total)::int as max_history,
      count(distinct workspace_id)::int as workspaces,
      (select count(*)::int from documents) as documents,
      (select count(*)::int from document_versions) as versions,
      (select count(*)::int from outbox) as outbox_rows
    from v`);
  return rows[0];
}
