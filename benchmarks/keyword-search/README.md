# Keyword search storage experiment

Raw results from `scripts/bench/keyword-experiment-run.mjs`, cited by [ADR 0012](../../docs/adr/0012-keyword-search-storage.md). Files are unmodified harness output.

| File | Chunks | Commit | Working tree | Completed (UTC) |
| --- | --- | --- | --- | --- |
| `keyword-experiment-50k.json` | 50,000 | `c1490c3` | clean | 2026-11-16 04:57 |
| `keyword-experiment-100k.json` | 100,000 | `c1490c3` | clean | 2026-11-16 05:17 |

Each size ran once on one laptop in a disposable PostgreSQL 18.6 container with a synthetic corpus and warm caches. They are exploratory evidence for a proposed decision, not a published benchmark: no run was repeated, and the 100,000-chunk latencies are noisy (see the ADR). The harness's `limitations` field in each file lists what the numbers do not cover.
