// Database-side counters read through the fixture role between and after scenarios.

import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";

const TABLES = ["chunks", "chunk_embeddings", "sections"];

// pg_stat_database is flushed lazily; give it a moment so a read after a burst includes the burst.
const FLUSH_MS = 1500;

/** Container CPU time from the cgroup, or null when the container does not expose it. */
export function cpuUsec(docker, name) {
  const read = docker(["exec", name, "cat", "/sys/fs/cgroup/cpu.stat"]);
  const match = /usage_usec (\d+)/.exec(read.stdout);
  return match ? Number(match[1]) : null;
}

export async function snapshot(fixture, docker, postgres) {
  await sleep(FLUSH_MS);
  const one = async (text, values) => (await fixture.query(text, values)).rows[0];
  const stat = await one(
    `select xact_commit::bigint, xact_rollback::bigint, deadlocks::bigint, temp_files::bigint,
       blks_read::bigint, blks_hit::bigint
     from pg_stat_database where datname = current_database()`,
  );
  const { rows: sizes } = await fixture.query(
    `select c.relname as table, pg_relation_size(c.oid)::bigint as heap,
       pg_indexes_size(c.oid)::bigint as indexes,
       (pg_total_relation_size(c.oid) - pg_relation_size(c.oid) - pg_indexes_size(c.oid))::bigint as toast_and_maps,
       c.reltuples::bigint as estimated_rows
     from pg_class c where c.relname = any($1) and c.relkind = 'r'`,
    [TABLES],
  );
  const counts = await one(
    `select (select count(*) from chunks)::int as chunks,
       (select count(*) from chunk_embeddings)::int as embeddings,
       (select count(*) from sections)::int as sections`,
  );
  return {
    lsn: (await one("select pg_current_wal_lsn()::text as lsn")).lsn,
    stat: Object.fromEntries(Object.entries(stat).map(([k, v]) => [k, Number(v)])),
    sizes: Object.fromEntries(
      sizes.map((r) => [
        r.table,
        {
          heap: Number(r.heap),
          indexes: Number(r.indexes),
          toastAndMaps: Number(r.toast_and_maps),
          estimatedRows: Number(r.estimated_rows),
        },
      ]),
    ),
    counts,
    cpuUsec: cpuUsec(docker, postgres),
    takenAtMs: performance.now(),
  };
}

/** Difference between two snapshots: WAL, counters, rows added and size per added chunk. */
export async function delta(fixture, before, after) {
  const { rows } = await fixture.query(
    "select pg_wal_lsn_diff($1::pg_lsn, $2::pg_lsn)::bigint as bytes",
    [after.lsn, before.lsn],
  );
  const grew = (table) => {
    const total = ({ sizes }) => {
      const t = sizes[table];
      return t ? t.heap + t.indexes + t.toastAndMaps : 0;
    };
    return total(after) - total(before);
  };
  const added = after.counts.chunks - before.counts.chunks;
  const perChunk = (n) => (added > 0 ? Math.round(n / added) : null);
  return {
    walBytes: Number(rows[0].bytes),
    walBytesPerChunk: perChunk(Number(rows[0].bytes)),
    // The CPU counter and the interval it covers, so CPU use is a rate over the same time span.
    intervalMs: after.takenAtMs - before.takenAtMs,
    chunksAdded: added,
    chunkTableBytesPerChunk: perChunk(grew("chunks")),
    embeddingTableBytesPerChunk: perChunk(grew("chunk_embeddings")),
    postgresCpuMs:
      before.cpuUsec === null || after.cpuUsec === null
        ? null
        : (after.cpuUsec - before.cpuUsec) / 1000,
    counters: Object.fromEntries(
      Object.keys(after.stat).map((k) => [k, after.stat[k] - before.stat[k]]),
    ),
  };
}
