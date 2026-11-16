# Ingestion baseline

Raw results from `scripts/bench/ingestion-bench.mjs`, cited by [ADR 0012](../../docs/adr/0012-keyword-search-storage.md). The JSON files are unmodified harness output (byte-identical to what the harness wrote; Biome does not format them). They are the baseline for comparing ingestion cost before and after a stored text-search vector. They contain no credentials, host paths or document text.

| File | Run ID | Completed (UTC) | SHA-256 |
| --- | --- | --- | --- |
| `ingestion-clean-run1.json` | `1b5c3e7d` | 2026-11-16 09:43 | `e3c4a36f4cd7881e089bba92ba1e49305d30db8ef2471f7bc5231417efd6ea22` |
| `ingestion-clean-run2.json` | `08b870f9` | 2026-11-16 09:52 | `5947016d0e26a98d6b897d966b13be6009559fc53f7f676df6184f38e43b8908` |
| `ingestion-clean-run3.json` | `c46a4bf6` | 2026-11-16 10:00 | `02c2b7516b6b18e729b53134016c821e3e79f19e20ac144fcaedcaf067adb583` |

## Provenance

All three runs are `status: complete` at commit `09fa52f` with `workingTreeDirty: false` and no dirty files, and ran back to back from one clean checkout. Each run recorded `cleanup.verified: true` for both containers. The exact command was:

```
node scripts/bench/ingestion-bench.mjs run --execute --repeats=10 --rounds=3 --out=<file>.json
```

## Configuration

- One discarded warm-up document, then 10 sequential documents (concurrency 1) of each class: small (20,000 characters, 12 chunks), medium (200,000, 112), large (1,000,000, 556) and max (2,000,000, 1,113).
- One document of exactly the parser's input limit, which the parser rejects (`parse.text_too_large`), as designed.
- 20 maximum-size documents at concurrency 1, 2 (the production default) and 4, in 3 rounds whose order rotates so each level takes each position once. All levels get identical documents.
- One workspace of 50 mixed documents (30 small, 14 medium, 5 large, 1 max) at concurrency 2.
- The production worker consumer, stages and activation transaction run as the unprivileged worker role (`contextvault_worker`, row-level security forced, 15 s `statement_timeout`).

## Environment

Apple M1 Pro (8 cores), 16 GB, macOS (Darwin 25.6.0), Node 24.22.1. PostgreSQL 18.6 with pgvector 0.8.7 (`pgvector/pgvector:0.8.7-pg18`, image digest recorded in each file) in a disposable container limited to 2 CPUs and 4 GB, with `shared_buffers` 128 MB, `work_mem` 4 MB and `jit` on. Redis 8.2 in a second disposable container. The worker process runs on the host, outside Docker. Both containers publish to a random loopback port, and the harness proves by marker that the database and queue it uses are the ones it created.

## Reproducibility

The documents are deterministic; timings are not. Chunks per document were identical, table bytes per chunk agreed within about 1 %, and WAL per chunk in the sequential scenarios within about 6 % (10.1 to 10.7 KB) across the three runs. Latencies have a heavy right tail on a laptop: some scenarios ran 1.5 to 2 times slower with the worker using under half a core, and the cause was not investigated. Compare medians, not maxima. Earlier dirty-tree runs of the same harness at `c1490c3` are not committed.

## Limitations

- Every `*ClientMs` field is client-observed: it includes the driver, the network and event-loop delay in the worker, and is **not** PostgreSQL execution time. `pg_stat_statements` was not enabled, so no server-side statement time was measured.
- Concurrency 2 and 4 are limited by the single-threaded worker process (event-loop utilization 0.8 to 0.9; some runs flagged `worker-cpu` or `worker-event-loop`), so their timings measure worker scheduling as much as the database. Use concurrency 1 for database cost.
- WAL per chunk is reliable only in the sequential scenarios. In the bursts the measured window also includes background activity, and values range from 10 to 29 KB per chunk.
- Object reads come from memory, embeddings are the offline hash embedder, only plain text is parsed, and the outbox, recovery sweeps and failure injection are not exercised. The scenarios share one growing database (218,000 to 224,000 chunks by the end), and each file's `limitations` field lists the rest.
- The schema has no stored text-search vector yet, so these are baseline figures only.
