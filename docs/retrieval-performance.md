# Retrieval performance

Measured on the repository's isolated test stack with `scripts/bench/retrieval-bench.mjs` (M2.2e). Raw numbers: [`benchmarks/retrieval/results.json`](../benchmarks/retrieval/results.json) (full plans at limit 50) and [`report.md`](../benchmarks/retrieval/report.md), which is rendered from the JSON (a unit test checks that they agree). Everything below is either a measurement or is labelled as inference or not measured.

## Method

- Run: `CV_TEST_ENV_DIR=<dir> node scripts/test-stack/with-test-stack.mjs node scripts/bench/retrieval-bench.mjs --sizes=1000,10000,50000,100000`. The script refuses to run outside the wrapper and re-checks the stack itself: both database URLs are loopback, off the development port and name one database, and that database carries the stack's identity marker. It creates one user and one workspace per size through the fixture role, removes them afterwards, changes no schema and creates no index.
- What is measured: the SQL of the production `createSearchRepository` (bundled from source, rendered by drizzle, run through `pg`) and the production `fuseRrf`. Queries run as the application role inside a transaction with tenant context, so row-level security is included. `EXPLAIN (ANALYZE, BUFFERS)` of the same statements gives the plans.
- Hybrid figures are **two repository calls plus `fuseRrf`** in one transaction. They do not include the HTTP layer, authentication, the embedder or the unit of work, so they are a lower bound for the full API path.
- Corpus: deterministic (`retrieval-corpus.mjs`): seeded PRNG, md5-derived ids, 50 live documents (the upload quota), chunks of about 1,900 characters of Zipf-like synthetic words (the chunker's 2,000-unit window), random unit vectors of 1,536 dimensions. A smaller corpus is a prefix of a larger one, and the dataset digests in the report show that two runs used identical data. Keyword workloads use planted terms of exact frequency: `rare` (1 in 5,000 chunks), `mid` (1 %), `common` (50 %), `and` (common + mid), `phrase` and `absent`. Vector queries use three fixed vectors.
- Timing: warm cache (reads come from shared buffers, except at 50k and 100k where some blocks are read). Up to 7 timed runs after a warm-up, reported as median and min-max. A statement slower than 2 s is timed only twice (the run count `n` is printed). A statement that hits the application role's 15 s `statement_timeout` is recorded as `timeout`, which is what production would return. Timings vary between runs on a developer laptop: compare orders of magnitude, not single digits. The 1,000-chunk tier ran first and is the noisiest.
- Reproducibility: the data is deterministic; timings are not. Re-running gives the same dataset digests and similar, not identical, timings. The committed files were produced by one 28-minute run (27 min 47 s); they have not been regenerated.

### Historical metadata correction

The committed `results.json` and `report.md` came from an earlier revision of the script whose `environment` block also held `prodLoaded: "function"` (a leftover value that no current script or the report renderer reads; no measurement used it). The field was deleted from both files after confirming that nothing reads it and that `report.md` is exactly `renderReport(results.json)`. No measured value was changed.

### Median definition in the committed results

The committed run computed a "median" as `sorted[floor(n / 2)]`. For an odd number of samples (n=7 or n=5, which covers the vector cases up to 50,000 chunks, every keyword and hybrid case at 1,000 chunks, and the EXPLAIN runs) that is the conventional median. For an **even** number it is the **upper** of the two middle samples, so:

- every statement that was timed twice (n=2: the keyword and hybrid cases at 10,000 and 50,000 chunks, and the vector cases at 100,000 chunks) shows the **slower of its two runs**, not a median; the faster run is in `results.json` (`runs`, `min`);
- the transaction-overhead series (n=20) shows the upper-middle value, a little above the conventional median (see finding 5).

The committed `results.json` and `report.md` keep these values unchanged, so below they are called "slower of two runs" where n=2. `stats()` in `scripts/bench/retrieval-timing.mjs` now averages the two middle samples for an even count (`stats([1, 3]).median === 2`), so a **future** run will report conventional medians and its n=2 entries will differ from these (lower, never higher). `retrieval-report.mjs` computes EXPLAIN medians itself; those series always have an odd count (7 timed runs, or one run for a slow statement), so they are unaffected.

## Environment

PostgreSQL 18.6 and pgvector 0.8.7 in the repository's isolated test stack (a container on the same machine), Apple M1 Pro with 8 cores and 16 GB, macOS 25.6, Node 24.22.1. Server settings: `shared_buffers` 128 MB, `work_mem` 4 MB, `jit` on (never used by these plans), 2 parallel workers per gather, autovacuum on. The test database held other tests' rows (41 workspaces, no chunks) before seeding. Tables were `VACUUM (ANALYZE)`d after seeding.

## Results (wall time includes the transaction and tenant-context round trips; medians, except where n=2, which is the slower of two runs)

| Chunks in workspace | Vector, limit 5 / 50 | Keyword, selective term (`rare`, `absent`) | Keyword, `common` (50 % match) | Hybrid (50 + 50) |
| --- | --- | --- | --- | --- |
| 1,000 | 209 / 196 ms (noisy) | 0.31-0.45 s | 0.88-1.4 s | 0.38-1.3 s |
| 10,000 | 163 / 148 ms | 2.4-5.4 s (n=2, slower of two) | 5.0-8.7 s (n=2, slower of two) | 2.3-4.9 s (n=2, slower of two) |
| 50,000 | 989 / 919 ms | 11.2-13.9 s (n=2, slower of two) | **timeout (15 s)** | 12.0-12.9 s (n=2, slower of two) for selective terms, **timeout** for `mid`, `common`, `and`, `phrase` |
| 100,000 | 2.7 / 3.3 s (n=2, slower of two) | **timeout (15 s) in every case, including no match** | timeout | **timeout** |

The upload quota allows up to about 116,000 chunks in one workspace (200 MiB of text at one chunk per 1,800 new characters), so the 100,000 tier is close to the worst case the quota permits.

### Findings

1. **Keyword search is a linear scan and reaches the 15 s limit between 10k and 50k chunks.** Every case reads the whole workspace (`Index Scan chunks_workspace_version_idx`, rows removed by filter equal to the workspace size) and computes `to_tsvector('simple', content)` for each row: roughly 0.23-0.37 ms of EXPLAIN execution time per chunk for every case except `common` (one 1,000-chunk `phrase` run was 0.45), independent of how many chunks match (`absent` costs as much as `rare`). `common` measured 0.49-0.77 ms per chunk; its extra work is a second `to_tsvector` and a `ts_rank_cd` per matching row (inferred from the SQL, not isolated by a measurement). At 50,000 chunks only `rare` and `absent` finished; at 100,000 none did, so keyword search returns a database timeout error there. **Caution at 50,000 chunks:** the statements that finished took 11.2-13.9 s (the slower of two runs; the faster runs took 11.1-12.4 s), about 7-25 % below the 15 s limit. At that distance a few seconds of run-to-run variation can decide whether a run times out, so which of `mid`, `phrase` and `and` timed out while `rare` and `absent` finished is not evidence that ranking or matching those cases costs more. The measurements support the per-chunk scan cost and the 10k-50k crossing, not a ranking-cost difference between cases.
2. **Hybrid search and grounded answers inherit the keyword cost.** The two statements run one after the other in one transaction, so hybrid wall time is about the sum of the separate vector and keyword wall times (0.6 to 1.2 times that sum in the cases that finished, mostly below it); fusion is not a factor. Hybrid and the grounded-answer flow (which uses hybrid) fail whenever keyword times out. This matters for workspaces with tens of thousands of chunks; at 1,000 chunks every case finished in under 1.5 s.
3. **Vector search is an exact scan and also grows linearly**, at 15-33 µs per chunk from 10,000 chunks up (about 200 µs per chunk at 1,000, where the plan differs): about 0.15 s at 10k, 0.9 s at 50k and 2.7-3.3 s at 100k. The plan is a nested loop that looks up `chunk_embeddings` by primary key once per chunk, then sorts all distances (`Sort` + `Limit`). It stayed under the timeout at every measured size. At 1,000 chunks the planner probed the `(workspace_id, model)` index once per chunk instead (500,500 index rows read); that plan disappears by 10,000. An approximate index (HNSW) remains an M2/M4 decision and was not needed to stay under the timeout at the sizes measured.
4. **Fetching 50 + 50 candidates instead of 5 costs nothing measurable.** The scan dominates: limit 5 and limit 50 differ by run-to-run noise, with no consistent direction (vector wall times within about 20 %; keyword wall times up to 1.7 times apart in the n=2 data, with limit 5 the slower one, which a smaller limit cannot explain; EXPLAIN execution times mostly within 10 %). The 100 candidates carry 0.08-0.16 MB of chunk text and `fuseRrf` takes 0.01-0.15 ms per call, so the pool size is not a performance lever.
5. **Transaction and tenant-context overhead** (begin, two `set_config`, rollback) had a median of 1.2-2.4 ms at 10,000 chunks and above (largest single run 7.6 ms; the committed files show 1.3-2.5 ms, the upper-middle value of 20 runs). The 1,000-chunk tier, which ran first, had a median of 35.4 ms (committed value 37.2 ms; largest run 79.9 ms). That is the whole first tier, not one outlier; the cause was not diagnosed (a cold start of the connection or server is a likely but untested explanation), and it is one more reason to treat the 1,000-chunk figures as noisy.

### How far to trust the 10k figures

At 10,000 chunks the selective keyword cases (`rare`, `absent`) took 2.4-5.4 s and `common` took 5.0-8.7 s. Each is the slower of two runs: for example `common` at limit 5 took 5.0 s and 8.7 s, so the two runs of one statement differed by 1.7 times, and `rare` at limit 5 took 3.2 s and 5.4 s. These are single-user, warm-cache measurements on an idle laptop. They show that 10k is the largest measured size at which every case finished. They are not a reliability guarantee: concurrent searches, a cold cache, a slower disk, a shared database server or real text with different term statistics could each move a statement across the limit, and none of those were measured.

## GIN index decision

Not created (no migration without approval) and **not measured**: the fixture role cannot create temporary tables, and building an index in the shared test database was out of scope. What follows is inference from the measurements, apart from the catalog facts in the next section.

- The cost that breaks the limit is the per-row `to_tsvector` in the match predicate. A GIN expression index on `to_tsvector('simple', content)` (the SQL already uses that exact expression for this reason) could let selective queries (`rare`, `mid`, `phrase`, `absent`) skip the scan, with cost driven by the matching rows; it would still recompute `to_tsvector` for `ts_rank_cd`.
- It would **not** fix `common`-style queries (half the corpus matches): ranking still computes a tsvector per match. A stored `tsvector` column removes that recompute but adds storage and write cost; capping matches is a separate option. Each of these is a separate decision.
- Not measured: index size and build time, write cost during ingestion, and the effect of the `simple` configuration's limits (no stemming; CJK tokenizes poorly).
- Whether the planner would use the index **under row-level security** is open, see below.
- **Recommendation:** treat a GIN index (or a stored tsvector) as justified for workspaces above roughly 10,000 chunks, subject to an ADR, a migration (each separately approved) and a measurement on a throwaway database as the application role. The measured ceiling is: all keyword and hybrid cases finished up to 10,000 chunks per workspace under the conditions above; 50,000 and above can time out.

### GIN and row-level security: confirmed and open

Confirmed by `scripts/bench/retrieval-rls-probe.mjs` (read-only catalog queries, isolated stack, 2026-11-12):

- The application role `contextvault_app` is not a superuser, does not have `BYPASSRLS`, and does not own the tables. `chunks`, `chunk_embeddings`, `documents`, `document_versions` and `memberships` have RLS enabled **and forced**. The `chunks_app_select` policy requires `workspace_id` to equal the `app.workspace_id` setting and the `app.user_id` setting to name a member (an `EXISTS` over `memberships`).
- `to_tsvector`, `websearch_to_tsquery`, `ts_rank_cd` and the `@@` operator's functions (`ts_match_vq`, `ts_match_qv`) are all **not** marked `LEAKPROOF`.
- The fixture role `contextvault_fixture` **does** have `BYPASSRLS`. Anything measured through the fixture role (including a prototype index test) says nothing about the application role's plans.
- `chunks` currently has no text-search index (indexes: primary key, two unique constraints, `chunks_section_idx`, `chunks_workspace_version_idx`).

Not confirmed: PostgreSQL restricts how conditions that are not leakproof can be pushed below row-level-security conditions, which can keep the planner from using an index for them. Catalog metadata alone does not prove that a GIN index would be ignored for the application role, or that it would be used. This needs `EXPLAIN` as `contextvault_app`, with the tenant settings, on a throwaway index, in a throwaway database (not yet run; no index, table or migration was created).

## Limits of the measurement

One machine, one PostgreSQL build, warm cache, synthetic text and random vectors (planner behaviour on real text, and ranking quality, were not measured). Single-user latency only: no concurrency, no write load, no cold cache. Only 1,536-dimension hash-sized vectors were used and no embedding provider was involved. Wall times at 10k and above come from two runs for the slow statements.
