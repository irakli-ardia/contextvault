# 0012 — Keyword search storage: stored generated tsvector, no GIN index

Status: proposed — 2026-11-16. Not accepted until the deployment inventory is confirmed and the migration approach and database change are approved (see [Gates](#gates-before-migration-0022)).

## Context

Keyword search computes `to_tsvector('simple', c.content)` for every chunk in the workspace, once in the match predicate and again in `ts_rank_cd` for every match (`packages/db/src/repositories/retrieval/search-repository.ts`). The cost is linear in workspace size and independent of how many chunks match. [Retrieval performance](../retrieval-performance.md) measured keyword search as the application role against a 15 s `statement_timeout`: at 50,000 chunks the baseline took about 10.5 s for a rare term and timed out for a common one, and at 100,000 every case timed out. Hybrid search and grounded answers run keyword search, so they fail with it. A workspace holds at most 50 live documents of at most 2,000,000 characters each. A maximum-size document produced 1,113 chunks when measured, so a full workspace has about 56,000 searchable chunks (a bound derived from the chunker's window, overlap and break lookback is about 71,000). The byte quota (200 MiB, counted until a deleted document is purged) can briefly leave more rows behind. The 100,000-chunk measurements below are therefore a scale stress above what one workspace can reach, and are relevant to the global table, which no quota bounds.

Facts from the code that constrain the decision:

- `chunks` is written once per document version, inside the activation transaction (sections, then chunks in batches of 1,000 rows, then embeddings; `activate-version.ts`). No role has `UPDATE` on `chunks`; the only other write is the purge `DELETE`.
- Row-level security is enabled and forced on `chunks`. The policies on `chunks` name only the application and worker roles, so the table owner sees and updates no rows through ordinary statements.
- The migrator applies every pending migration in one transaction. `CREATE INDEX CONCURRENTLY` is unavailable, and a lock taken by one migration is held until the last pending migration commits.
- The application and worker roles run with `statement_timeout = 15s`. Activations that fail roll back entirely and are retried by the database-owned job state, fenced by the lease generation.
- `chunks` is one table for all workspaces. No quota bounds the number of workspaces, so the table's global size, which determines the cost of any rewrite, is unbounded.

## Decision (proposed)

Store the text-search vector once per chunk as a generated column and have keyword search read it. Add no text-search index.

```sql
ALTER TABLE chunks
  ADD COLUMN content_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, content)) STORED NOT NULL;
GRANT SELECT (content_tsv) ON chunks TO contextvault_app;
```

The keyword statement replaces both `to_tsvector('simple', c.content)` expressions with `c.content_tsv`. The query text, `websearch_to_tsquery('simple', …)`, the score filter, ordering, limit, the authorization conditions inside the statement and the row-level-security policies are unchanged. Ranking is identical by construction: the same function over the same stored value.

`STORED` must be written explicitly: PostgreSQL 18 makes generated columns virtual by default, and a virtual column is recomputed on every read, which is the cost this decision removes.

This is the preferred architecture, subject to deployment and migration safety approval. It is not approved for any database whose size and availability requirements are unknown.

### Out of scope

- **Vector indexing.** Exact vector scanning is likely the next bottleneck for hybrid search at quota (2.7–3.3 s at 100,000 chunks in [retrieval performance](../retrieval-performance.md)). An approximate index, a different exact-scan plan or partitioning is a separate decision.
- Other text-search configurations, stemming, ranking changes and result caps.

## Evidence

All figures come from the repository's keyword experiment harness (`scripts/bench/keyword-experiment-run.mjs`) in a disposable PostgreSQL 18.6 container (pgvector 0.8.7) on one developer laptop. The corpus is synthetic text, caches are warm, and queries run as the application role under forced row-level security with the tenant context set (one large workspace plus a 1,000-chunk second tenant). The statement timeout is 15 s. Each latency is the median (p50) of five wall-clock samples of the keyword statement; slow statements get fewer samples, and a statement that exceeds the timeout during warm-up yields none.

Three measurement sets are cited. Only the clean-tree results are committed, and no figure here is a published benchmark result.

- **Clean-tree runs (B).** Commit `c1490c3` with `workingTreeDirty: false`, both runs complete, `containerRemoved: true`, 16 November 2026. Results: [`benchmarks/keyword-search/keyword-experiment-50k.json`](../../benchmarks/keyword-search/keyword-experiment-50k.json) and [`keyword-experiment-100k.json`](../../benchmarks/keyword-search/keyword-experiment-100k.json), unmodified harness output (see the [folder README](../../benchmarks/keyword-search/README.md)). Console logs are not kept. These are the primary evidence.
- **Earlier exploratory runs (A).** Commit `6e54d39` with `workingTreeDirty: true` (uncommitted harness), 15 November 2026. Files: `keyword-experiment-50k-20261115T165222Z-51408.json` and `keyword-experiment-100k-20261115T171531Z-1372.json`. They are not committed and are context only.

- **Ingestion baseline (C).** Commit `09fa52f`, three complete runs with `workingTreeDirty: false`, 16 November 2026, before any stored vector exists. Files: [`benchmarks/ingestion/`](../../benchmarks/ingestion/README.md), unmodified harness output.

Each keyword size was run once per set, so "reproduced" below means that A and B agree, not that a run was repeated for variance.

### Query latency, stored column, no index (p50, ms; sample range in brackets)

| Dataset | Query type | Clean tree (B) | Exploratory (A) | Status |
| --- | --- | --- | --- | --- |
| 50,000 chunks | rare term | 355 [350–358] | 423 | Reproduced: B within 6–20 % of A and tightly clustered |
| 50,000 chunks | common term | 522 [511–600] | 646 | Reproduced (same) |
| 50,000 chunks | absent term | 371 [360–451] | 395 | Reproduced (same) |
| 100,000 chunks | rare term | 1,756 [1,121–3,390] | 681 | **Noisy, not reproduced** |
| 100,000 chunks | common term | 2,107 [1,329–3,096] | 1,031 | **Noisy, not reproduced** |
| 100,000 chunks | absent term | 1,825 [1,458–5,070] | 675 | **Noisy, not reproduced** |

At 50,000 chunks the figures are stable. At 100,000 chunks the clean-tree medians are two to three times the exploratory ones, individual samples range up to 5.1 s, and the same experiment's stored-column-plus-GIN variant (where the application role still did not use GIN) measured 693 / 1,016 / 709 ms in the same run. The spread is therefore not explained by the index and is **not a latency to plan against or promise**. The result shows only that, in these runs, keyword search at 100,000 chunks completed in a few seconds at most, well under the 15 s timeout, where the current implementation does not. No p95 or p99 was measured, and the cause of the noise (laptop load, cache or storage behaviour) was not investigated.

### Baseline (current expression)

| Dataset | rare | common | absent |
| --- | --- | --- | --- |
| 50,000 chunks, clean tree | 12.2 s | timed out (no sample) | 11.1 s |
| 100,000 chunks, clean tree | timed out | timed out | timed out |

Timed out means the first warm-up execution exceeded the 15 s limit, so no latency sample exists and the figure is a lower bound, not a median. The earlier runs agree (about 10.5 s for rare and absent terms at 50,000 chunks, timeouts elsewhere).

### Other findings

- **Correctness:** at both sizes every stored-column case returned the same rows and scores as the baseline expression (row digests compared; clean tree).
- **Tenant isolation:** the isolation check passed with no failures for every variant that ran, with a second 1,000-chunk tenant in the corpus (clean tree).
- **GIN:** the application role's plans never used a GIN index, in the expression-index or the stored-column variants, at either size, in both sets of runs. No GIN benefit for the application role was observed. A GIN index did cost space and insertion time. At 100,000 chunks, inserting 5,000 rows (median of three, clean tree) took 13.4 s with the expression index and 5.1 s with the stored column plus GIN, against 3.2 s for the stored column alone and 0.3 s for the baseline. These are different variants of the same run, not conflicting measurements. The index added 148 MB at 100,000 chunks. The likely reason it is unused is that the text-search operators are not `LEAKPROOF`, so the planner will not evaluate them ahead of the row-level-security conditions; the plans are measured, the reason is inference. Plans that bypass row-level security (owner role) are used only to explain planner behaviour.
- **Storage:** the `chunks` table grew from 104.5 MB to 386.7 MB at 51,000 chunks and from 206.9 MB to 765.6 MB at 101,000 chunks, **3.7×** each time (total with indexes 3.5× at 101,000). The stored values account for 423 MB at 101,000 chunks; the rest of the growth is not explained. Synthetic text only; real text is not measured.

### Negative findings

| Measurement (stored column) | 50,000 chunks | 100,000 chunks | Earlier exploratory |
| --- | --- | --- | --- |
| Table rewrite by `ADD COLUMN … STORED` | 14.7 s | **62.8 s** | 15.6 s and 37.3 s |
| 5,000-row insert (median of three) | 1.5 s (baseline 0.24 s) | **3.2 s** (baseline 0.32 s) | 1.7 s and 1.5 s |

- **The rewrite is long and variable.** At 100,000 chunks it took 62.8 s on a clean tree against 37.3 s in the exploratory run, and the stored-column-plus-GIN variant of the same run took 49.6 s. It held `ACCESS EXCLUSIVE` throughout. The proposed 60 s hard cap was exceeded in one run, so the cap is **not shown to be safe**, and the rate per chunk is not stable enough to extrapolate to other sizes or hardware.
- **Insertion cost is about ten times the baseline.** Stored-column inserts took 1.5 s at 50,000 chunks and 3.2 s at 100,000, against 0.24 s and 0.32 s for the baseline. The proposed target of at most 2 s extra for a maximum-size activation is **not validated**: the measurement is a rolled-back `INSERT … SELECT` of synthetic rows, not the activation pipeline, and the 100,000-chunk figure (3.2 s) exceeds 2 s on its own.

### Ingestion baseline (set C, current schema, no stored vector)

The production worker consumer, stages and activation transaction, run as the unprivileged worker role under forced row-level security, with the offline hash embedder and an in-memory object store, in a disposable container limited to 2 CPUs (the worker runs on the host). Three complete runs, each 10 sequential documents per size class and 20 maximum-size documents at three concurrency levels in three rotated rounds. Every valid document reached `ready` on its first attempt in every run; there were no statement errors, rollbacks, deadlocks or retries; the document of exactly the parser's input limit was rejected as designed (`parse.text_too_large`); chunk and embedding counts matched. Running as that role under forced row-level security shows that the activation works with the production grants. It is not a cross-tenant isolation test: the benchmark used no second tenant and asserted no isolation, so isolation remains covered only by the checks cited above and by the tests in the gates.

**Sequential, concurrency 1 (the database-cost baseline).** Median per document across the three runs (range of the three run medians), milliseconds. A maximum-size document is 1,113 chunks.

| Document | Chunks | End to end | Activation transaction | Chunk INSERT | Embedding INSERT |
| --- | --- | --- | --- | --- | --- |
| small | 12 | 77–126 | 17–37 | 1.9–4.3 | 3.9–10.1 |
| medium | 112 | 198–329 | 69–129 | 10.6–17.9 | 33–48 |
| large | 556 | 741–905 | 283–397 | 60–86 | 136–195 |
| max | 1,113 | 1,394–2,278 | 562–1,033 | 107–185 | 292–534 |

- Parsing was 40–76 ms median at every size. Chunking and embedding each cost about 0.7 ms per chunk and run in the worker process, outside the transaction.
- The largest single statement client-observed in the sequential max-size scenarios was 110–565 ms (a statement-level maximum, not a median). The largest activation transaction across all concurrency-1 scenarios (sequential and burst) was 2.3 s. Across all bursts, including concurrency 4, it was 6.7 s and the largest statement 2.9 s, both client-observed under a saturated worker.
- WAL per chunk was 10.1–10.7 KB; table bytes per chunk were about 3.2 KB for `chunks` and 8.4 KB for `chunk_embeddings` (heap, index and TOAST as the harness reports them), stable within about 1 % across runs.
- Concurrency 1, 2 and 4 over 20 maximum-size documents (nine samples per level): median 36, 49 and 49 documents per minute (ranges 19–40, 24–53 and 42–55). Concurrency 2 is about 1.35 times faster than 1, and 4 adds almost nothing over 2. At concurrency 4 the worker's event loop was 0.86–0.92 utilized in most scenarios (four flagged saturated), and the event-loop delay at p99 was about 0.75–0.8 s at concurrency 1 (one burst 1.8 s) and up to 1.0 s at 2 and 4. Client-observed activation times at concurrency 2 and 4 (median about 1.5 s and 3 s) therefore include worker scheduling and are not database cost.
- Outliers: in several scenarios (the sequential scenarios of one run, several of the 27 bursts and one mixed workspace) the same work ran up to about twice as slow, often with the worker using under half a core. In the sequential case the CPU-only parse, chunk and embed stages slowed too, which points away from the database; no cause was diagnosed.

**What this does not measure.** Every `*ClientMs` figure is client-observed (driver, network and event-loop delay included) and is not PostgreSQL execution time; `pg_stat_statements` was not enabled, so no server-side timing exists. S3 latency, PDF parsing, real embedding providers, the outbox dispatcher, recovery sweeps and fault injection are not covered. Absolute numbers are bound to one laptop.

**Expected additional overhead (estimate, not a result).** The keyword experiment's clean-tree insert of 5,000 synthetic rows took 3.2 s against 0.32 s at 100,000 chunks (1.5 s against 0.24 s at 50,000), about 0.25–0.6 ms more per row. Applied to a maximum-size document's 1,113 rows this is roughly +0.3 to +0.7 s per activation, against a baseline median of 0.56–1.03 s at concurrency 1. This is arithmetic from a rolled-back `INSERT … SELECT`, not a measurement of the activation, and it is not an achieved or accepted target.

### Not measured

Hybrid search and the HTTP path after the change, concurrent load on search, cold cache, real text, ingestion after the column exists, server-side statement time, a quota-sized workspace of chunks (about 56,000, between the two measured sizes), and any database other than the disposable container.

## PostgreSQL behaviour this depends on

- **Locking and rewrite cost.** `ADD COLUMN … GENERATED ALWAYS AS (…) STORED` rewrites the whole table and its indexes under `ACCESS EXCLUSIVE`, which conflicts with every other lock mode, including the `ACCESS SHARE` that a plain `SELECT` takes. While it runs, keyword, vector and hybrid search, grounded answers, activations and purges on any workspace wait. The cost scales with the **global** row count, not one workspace. It also needs free disk for a second copy of the table and its indexes and writes WAL (both are expectations to measure in the rehearsal, not documented figures).
- **`lock_timeout` versus `statement_timeout`.** `lock_timeout` bounds only the wait to acquire the lock. While the `ACCESS EXCLUSIVE` request is queued, later requests on the table wait behind it (observed PostgreSQL behaviour, not stated on the locking documentation page), so a short `lock_timeout` (2 s proposed) limits that pile-up and fails fast if a long transaction holds the table. Once granted, the lock is held for the whole rewrite; only `statement_timeout` bounds the rewrite, and its clock starts when the command reaches the server, so it also covers the lock wait. The migration must set both itself with `SET LOCAL`, because the migration role's own timeouts are not configured by the role setup. `SET LOCAL` lasts until the migrator's single transaction ends, so the migration that adds the column ships alone in its release.
- **Waiting requests.** Requests blocked longer than 15 s fail with the existing database error. Activations roll back and are retried; nothing is lost, but search is unavailable for the duration.
- **Failure.** A timeout or a cancelled migrator aborts the whole transaction, so the migration is not recorded and the uncommitted new table copy is discarded. The documentation does not state this for the rewrite specifically; it follows from PostgreSQL's transactional DDL and should be confirmed in the rehearsal. It can be retried later or replaced by the trigger approach.
- **Row-level security.** A table rewrite by `ALTER TABLE` is not subject to row-level security. An `UPDATE` backfill is: under forced RLS the owner updates zero rows, so any backfill needs a temporary, reviewed bypass (an owner-only `UPDATE` policy, `NO FORCE ROW LEVEL SECURITY`, or a `BYPASSRLS` role). The new column is readable only through the existing `chunks` select policy and a column grant to the application role; the worker role gets no new privilege.
- **Sizing before a rewrite.** `pg_total_relation_size('chunks')` is exact and not subject to row-level security. `reltuples` and `n_live_tup` are estimates, and `count(*)` as the owner returns zero under forced RLS, so row counts are a cross-check only.

Verified against the PostgreSQL 18 documentation: generated columns ([ddl-generated-columns](https://www.postgresql.org/docs/18/ddl-generated-columns.html): virtual is the default; a virtual column is computed on read and takes no storage; a stored one is computed on write), `ALTER TABLE` ([sql-altertable](https://www.postgresql.org/docs/18/sql-altertable.html): adding a stored generated column rewrites the table and its indexes; `ACCESS EXCLUSIVE` unless noted), timeouts ([runtime-config-client](https://www.postgresql.org/docs/18/runtime-config-client.html): `lock_timeout` applies only while waiting for locks, per acquisition attempt; `statement_timeout` runs from command arrival to completion), lock modes ([explicit-locking](https://www.postgresql.org/docs/18/explicit-locking.html)) and `SET LOCAL` ([sql-set](https://www.postgresql.org/docs/18/sql-set.html): lasts to the end of the transaction). Not found in the documentation: lock-queue ordering and rewrite rollback, both labelled above.

## Generated `STORED` column versus trigger-maintained column

| | Generated `STORED` column | Regular column, `BEFORE INSERT` trigger, batched backfill |
| --- | --- | --- |
| Correctness | The database guarantees the value equals the expression; a writer cannot supply one | The trigger overwrites any supplied value; rows are `NULL` until backfilled |
| Lock | `ACCESS EXCLUSIVE` for the full rewrite of the global table | `ACCESS EXCLUSIVE` for milliseconds; the backfill takes row locks only |
| Row-level security | No bypass needed | Backfill needs a temporary, security-reviewed bypass |
| Transitional state | None | Keyword SQL reads `coalesce(c.content_tsv, to_tsvector('simple', c.content))` until the backfill completes; then `NOT NULL` via a `NOT VALID` check and `VALIDATE` |
| Write amplification | One new table copy during the rewrite | One dead tuple per existing row (about twice the table until vacuum) and WAL about the table's size |
| Changing the configuration later | Another full rewrite | Trigger change and another backfill |
| Code and review | One DDL statement and a grant | Trigger, backfill job, temporary policy, follow-up migrations |

A database takes one of the two; a generated column cannot later become a regular one or the reverse. Both end in the same column name, grant and keyword SQL.

**The generated column is appropriate** when the table is empty, disposable, or small enough that a measured rewrite fits the approved window with headroom, the owner accepts search and ingestion being unavailable for that window, free disk is at least twice the table's total size, and the rewrite has been rehearsed at that size.

**The trigger approach is appropriate** when retrieval and ingestion must stay available, when the predicted rewrite exceeds the window, when free disk is short, or when the database's size cannot be established. It needs its own security review of the backfill bypass and is not designed in detail here.

Also rejected: an application-maintained column (the same backfill as the trigger, no database guarantee, and a worker credential could write a mismatched vector); a separate search table (the trigger approach plus a join, policies and grants); any GIN index (unused by the application role's plans, while still adding index size and insert cost); `strip()`ped vectors (drops positions, which changes `ts_rank_cd` scores and breaks phrase queries); extensions or search engines outside the locked stack.

## Deployment status

Known: a local development database exists and holds data; the isolated test stack and the CI database are disposable, and CI applies every migration to an empty database. Unknown: whether any staging, production, demo or other hosted database exists, including one created outside the repository. The repository has no deployment workflow or hosting configuration, but that does not establish that no deployment exists. This record therefore assumes **nothing** about production, and no migration is applied to any database other than the test stack and CI until the inventory is confirmed.

## Compatibility and rollback

- **Order:** expand, then switch. Apply the column first; deploy the keyword SQL change afterwards. Code that predates the change works against the new schema (it recomputes the expression; worker inserts never name the column). The new SQL fails against the old schema (`column does not exist`), so it never deploys first.
- **Rollback without data loss:** the column is derived from `content`, so nothing can be lost. Revert the keyword SQL while the column exists; then, if needed, a later forward migration drops the column (a brief lock, metadata only). There are no down migrations. Disk space returns only after `VACUUM FULL`, which is another full rewrite under `ACCESS EXCLUSIVE` and needs its own approval.

## Gates before migration 0022

Migration 0022 (the column and grant) is not written until gates 1 and 2 are passed, and no database other than the test stack and CI receives it until every gate is passed and recorded (gates 3 to 5 are rehearsed and measured on disposable copies that carry it):

1. **Deployment inventory confirmed.** The owner states whether any hosted or deployed database exists or will hold data before this ships, and for each one its size and whether downtime is acceptable.
2. **Migration approach approved** per database: generated column or trigger, using the criteria above.
3. **Migration time and locking validated.** Rehearse on a restored copy or a synthetic table of the target's global size: rewrite duration, lock-acquisition wait, the longest blocked search and activation, disk and WAL. Approve the `lock_timeout` and `statement_timeout` values from those numbers; the 60 s cap is not approved as it stands.
4. **Real worker ingestion measured after the column.** The baseline exists (above). Still required: the same harness against the schema with the column (applied to the test stack and CI only), at the same commit-clean standard, interleaved with baseline runs on one machine; server-side statement time from `pg_stat_statements` in the disposable container; concurrent activations and an injected failure. Approve an ingestion target from the paired numbers; the 2 s target is not approved, and the baseline shows an absolute target needs to be set against the measured spread (a statement maximum varied about five-fold between runs).
5. **Tenant isolation verified on the new column.** The production cross-tenant, deleted, superseded, unfinished and failed-version matrix passes against the keyword statement that reads the column, and the grant catalog pins `SELECT(content_tsv)` for the application role only. Running the ingestion benchmark under forced row-level security does not count.
6. **Database change approved separately.** Approval of this record is not approval to change any database. Each environment (test stack and CI, local development, any hosted database) is approved on its own, with a verified backup and the rollback ready.

## Consequences

- If accepted, keyword search no longer scales with the per-row cost of `to_tsvector`, but still scans the whole workspace; latency stays linear in workspace size at a much lower rate.
- Storage grows several-fold and every activation pays the parsing cost at insert time inside its transaction.
- Adding the column to a large shared table is a maintenance event; the cost grows with every workspace, so the generated-column approach becomes less suitable the longer it waits on a populated database.
- Vector search remains an exact scan and is expected to dominate hybrid latency at quota.
