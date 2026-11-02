# Orphan discovery benchmark (generated)

Run 2026-11-02T09:18:00.300Z to 2026-11-02T09:32:16.038Z. Image `pgvector/pgvector:0.8.7-pg18@sha256:2358fcba361ed2233a5ed81b5fe4ca779ccb304120ce531a3bf51c0ed7e2bc11`, PostgreSQL server_version_num 180006, 127.0.0.1:55819, tmpfs only. Migrations applied: 13.

Settings: {"autovacuum":"off","effective_cache_size":"524288","fsync":"off","jit":"on","max_parallel_workers_per_gather":"2","random_page_cost":"4","shared_buffers":"32768","work_mem":"4096"}; worker statement_timeout 15s; privileged timeout 60 s.

## Dataset

```json

{
  "waiting": 200000,
  "with_live_outbox": 30000,
  "attempts_exhausted": 8000,
  "in_cooldown": 20000,
  "deleted_document": 14000,
  "history_ge_11": 8000,
  "max_history": 14,
  "workspaces": 20,
  "documents": 265000,
  "versions": 265000,
  "outbox_rows": 687002,
  "eligibleListed": 142000,
  "pages": 285
}

```

Scenarios (page size 500): [{"key":"page-1","rowsBefore":0,"depth":0},{"key":"depth-50","rowsBefore":71000,"depth":0.5},{"key":"depth-90","rowsBefore":128000,"depth":0.9014084507042254},{"key":"depth-99","rowsBefore":140500,"depth":0.9894366197183099}]. Rows visible to contextvault_owner (FORCE RLS, no owner policy): 0.

## Baseline scaling (page 1, privileged)

- 2000 waiting: 648 ms
- 5000 waiting: 2151 ms
- 10000 waiting: 8620 ms

## Visibility map

```json

{
  "pre-vacuum": [
    {
      "relname": "outbox",
      "relpages": 9786,
      "relallvisible": 0
    },
    {
      "relname": "document_versions",
      "relpages": 8031,
      "relallvisible": 0
    }
  ],
  "post-vacuum": [
    {
      "relname": "outbox",
      "relpages": 9786,
      "relallvisible": 9786
    },
    {
      "relname": "document_versions",
      "relpages": 8031,
      "relallvisible": 8031
    }
  ]
}

```

## pre-vacuum, role privileged: discovery execution time (shared buffers)

| variant | page-1 | depth-50 | depth-90 | depth-99 |
|---|---|---|---|---|
| baseline | 21776 ms (hit 6613677 / read 0) | 17005 ms (hit 6613617 / read 0) | 20521 ms (hit 6613617 / read 0) | 17085 ms (hit 6623403 / read 0) |
| A | 17420 ms (hit 6606253 / read 6) | 16331 ms (hit 6606254 / read 6) | 23264 ms (hit 6606254 / read 5) | 16241 ms (hit 6616042 / read 5) |
| B | 45 ms (hit 10963 / read 0, heap fetches 2120) | 35 ms (hit 10897 / read 0, heap fetches 2127) | 32 ms (hit 10902 / read 0, heap fetches 2131) | 22 ms (hit 10906 / read 0, heap fetches 2132) |
| A+B | 3.89 ms (hit 3545 / read 0, heap fetches 2120) | 3.18 ms (hit 3540 / read 0, heap fetches 2127) | 2.98 ms (hit 3544 / read 0, heap fetches 2131) | 3.20 ms (hit 3550 / read 0, heap fetches 2132) |
| A-include | 20964 ms (hit 6606253 / read 8, heap fetches 703) | 17856 ms (hit 6606254 / read 8, heap fetches 703) | 16485 ms (hit 6606254 / read 8, heap fetches 703) | 17156 ms (hit 6616041 / read 7, heap fetches 704) |
| A-include+B | 3.05 ms (hit 3547 / read 0, heap fetches 703+2120) | 2.31 ms (hit 3542 / read 0, heap fetches 703+2127) | 2.38 ms (hit 3547 / read 0, heap fetches 703+2131) | 3.24 ms (hit 3551 / read 0, heap fetches 704+2132) |
| B-no-include | 46 ms (hit 10955 / read 0) | 38 ms (hit 10890 / read 0) | 28 ms (hit 10896 / read 0) | 24 ms (hit 10901 / read 0) |
| A+B-no-include | 5.72 ms (hit 3537 / read 0) | 3.36 ms (hit 3533 / read 0) | 2.66 ms (hit 3538 / read 0) | 2.47 ms (hit 3545 / read 0) |

## pre-vacuum, role worker: discovery execution time (shared buffers)

| variant | page-1 | depth-50 | depth-90 | depth-99 |
|---|---|---|---|---|
| baseline | TIMEOUT (est. cost 30176663) | TIMEOUT (est. cost 30170611) | TIMEOUT (est. cost 30168675) | TIMEOUT (est. cost 30168206) |
| A | TIMEOUT (est. cost 30156747) | TIMEOUT (est. cost 30157306) | TIMEOUT (est. cost 30156195) | TIMEOUT (est. cost 30162279) |
| B | 117 ms (hit 10963 / read 0, heap fetches 2120) | 36 ms (hit 10897 / read 0, heap fetches 2127) | 31 ms (hit 10902 / read 0, heap fetches 2131) | 23 ms (hit 10906 / read 0, heap fetches 2132) |
| A+B | 2.56 ms (hit 3545 / read 0, heap fetches 2120) | 3.08 ms (hit 3540 / read 0, heap fetches 2127) | 2.54 ms (hit 3544 / read 0, heap fetches 2131) | 3.39 ms (hit 3550 / read 0, heap fetches 2132) |
| A-include | TIMEOUT (est. cost 30157078) | TIMEOUT (est. cost 30156709) | TIMEOUT (est. cost 30159368) | TIMEOUT (est. cost 30131562) |
| A-include+B | 6.82 ms (hit 3547 / read 0, heap fetches 703+2120) | 2.35 ms (hit 3542 / read 0, heap fetches 703+2127) | 2.69 ms (hit 3547 / read 0, heap fetches 703+2131) | 3.14 ms (hit 3551 / read 0, heap fetches 704+2132) |
| B-no-include | 58 ms (hit 10955 / read 0) | 40 ms (hit 10890 / read 0) | 27 ms (hit 10896 / read 0) | 21 ms (hit 10901 / read 0) |
| A+B-no-include | 3.36 ms (hit 3537 / read 0) | 6.54 ms (hit 3533 / read 0) | 3.94 ms (hit 3538 / read 0) | 4.43 ms (hit 3545 / read 0) |

## pre-vacuum: lockOrphan (16 versions x 3 runs)

| variant | role | statement 1 median / max ms | statement 2 median / max ms |
|---|---|---|---|
| baseline | privileged | 0.05 / 0.17 | 28 / 37 |
| baseline | worker | 0.05 / 0.21 | 27 / 47 |
| A | privileged | 0.06 / 2.98 | 28 / 315 |
| A | worker | 0.05 / 0.09 | 27 / 28 |
| B | privileged | 0.02 / 0.04 | 0.03 / 0.05 |
| B | worker | 0.03 / 0.10 | 0.03 / 0.13 |
| A+B | privileged | 0.03 / 0.07 | 0.03 / 0.06 |
| A+B | worker | 0.05 / 3.09 | 0.05 / 0.85 |
| A-include | privileged | 0.04 / 1.22 | 27 / 34 |
| A-include | worker | 0.06 / 0.19 | 28 / 186 |
| A-include+B | privileged | 0.03 / 0.09 | 0.03 / 0.12 |
| A-include+B | worker | 0.03 / 0.08 | 0.03 / 0.11 |
| B-no-include | privileged | 0.03 / 0.07 | 0.04 / 0.06 |
| B-no-include | worker | 0.03 / 0.04 | 0.03 / 0.07 |
| A+B-no-include | privileged | 0.04 / 0.27 | 0.04 / 0.36 |
| A+B-no-include | worker | 0.03 / 0.09 | 0.03 / 0.07 |

### pre-vacuum: index sizes and build times

- baseline: {}; build ms -

- A: {"bench_a":8142848}; build ms 152

- B: {"bench_b":40574976}; build ms 326

- A+B: {"bench_a":8142848,"bench_b":40574976}; build ms 68, 396

- A-include: {"bench_a_inc":13533184}; build ms 194

- A-include+B: {"bench_a_inc":13533184,"bench_b":40574976}; build ms 208, 572

- B-no-include: {"bench_bn":17793024}; build ms 279

- A+B-no-include: {"bench_a":8142848,"bench_bn":17793024}; build ms 59, 310

## post-vacuum, role privileged: discovery execution time (shared buffers)

| variant | page-1 | depth-50 | depth-90 | depth-99 |
|---|---|---|---|---|
| baseline | 15192 ms (hit 6613677 / read 0) | 18178 ms (hit 6613617 / read 0) | 15402 ms (hit 6613617 / read 0) | 16770 ms (hit 6623403 / read 0) |
| A | 15367 ms (hit 6606253 / read 6) | 14814 ms (hit 6606254 / read 6) | 17588 ms (hit 6606254 / read 5) | 14691 ms (hit 6616042 / read 5) |
| B | 49 ms (hit 10161 / read 0, heap fetches 0) | 37 ms (hit 10100 / read 0, heap fetches 0) | 26 ms (hit 10099 / read 0, heap fetches 0) | 21 ms (hit 10101 / read 0, heap fetches 0) |
| A+B | 2.30 ms (hit 2743 / read 0, heap fetches 0) | 2.13 ms (hit 2743 / read 0, heap fetches 0) | 2.77 ms (hit 2741 / read 0, heap fetches 0) | 2.21 ms (hit 2745 / read 0, heap fetches 0) |
| A-include | 12942 ms (hit 6605551 / read 8, heap fetches 0) | 12845 ms (hit 6605552 / read 8, heap fetches 0) | 13105 ms (hit 6605552 / read 8, heap fetches 0) | 12990 ms (hit 6615338 / read 7, heap fetches 0) |
| A-include+B | 2.23 ms (hit 2043 / read 0, heap fetches 0+0) | 1.83 ms (hit 2043 / read 0, heap fetches 0+0) | 2.27 ms (hit 2042 / read 0, heap fetches 0+0) | 2.17 ms (hit 2043 / read 0, heap fetches 0+0) |
| B-no-include | 42 ms (hit 10955 / read 0) | 33 ms (hit 10890 / read 0) | 25 ms (hit 10896 / read 0) | 28 ms (hit 10901 / read 0) |
| A+B-no-include | 2.23 ms (hit 3537 / read 0) | 3.07 ms (hit 3533 / read 0) | 2.52 ms (hit 3538 / read 0) | 3.05 ms (hit 3545 / read 0) |

## post-vacuum, role worker: discovery execution time (shared buffers)

| variant | page-1 | depth-50 | depth-90 | depth-99 |
|---|---|---|---|---|
| baseline | TIMEOUT (est. cost 30176324) | TIMEOUT (est. cost 30171219) | TIMEOUT (est. cost 30167096) | 14567 ms (hit 6623403 / read 0) |
| A | 14942 ms (hit 6606259 / read 0) | 13467 ms (hit 6606260 / read 0) | 13466 ms (hit 6606259 / read 0) | 13256 ms (hit 6616047 / read 0) |
| B | 42 ms (hit 10161 / read 0, heap fetches 0) | 33 ms (hit 10100 / read 0, heap fetches 0) | 25 ms (hit 10099 / read 0, heap fetches 0) | 22 ms (hit 10101 / read 0, heap fetches 0) |
| A+B | 2.00 ms (hit 2743 / read 0, heap fetches 0) | 2.62 ms (hit 2743 / read 0, heap fetches 0) | 2.04 ms (hit 2741 / read 0, heap fetches 0) | 2.24 ms (hit 2745 / read 0, heap fetches 0) |
| A-include | 13012 ms (hit 6605559 / read 0, heap fetches 0) | 12881 ms (hit 6605560 / read 0, heap fetches 0) | 12929 ms (hit 6605560 / read 0, heap fetches 0) | 13075 ms (hit 6615345 / read 0, heap fetches 0) |
| A-include+B | 1.77 ms (hit 2043 / read 0, heap fetches 0+0) | 1.73 ms (hit 2043 / read 0, heap fetches 0+0) | 2.08 ms (hit 2042 / read 0, heap fetches 0+0) | 2.27 ms (hit 2043 / read 0, heap fetches 0+0) |
| B-no-include | 44 ms (hit 10955 / read 0) | 34 ms (hit 10890 / read 0) | 26 ms (hit 10896 / read 0) | 21 ms (hit 10901 / read 0) |
| A+B-no-include | 2.26 ms (hit 3537 / read 0) | 2.31 ms (hit 3533 / read 0) | 2.22 ms (hit 3538 / read 0) | 2.26 ms (hit 3545 / read 0) |

## post-vacuum: lockOrphan (16 versions x 3 runs)

| variant | role | statement 1 median / max ms | statement 2 median / max ms |
|---|---|---|---|
| baseline | privileged | 0.04 / 1.92 | 27 / 80 |
| baseline | worker | 0.05 / 0.12 | 27 / 30 |
| A | privileged | 0.05 / 0.14 | 27 / 597 |
| A | worker | 0.05 / 0.12 | 26 / 85 |
| B | privileged | 0.02 / 0.08 | 0.02 / 0.04 |
| B | worker | 0.03 / 0.04 | 0.03 / 0.05 |
| A+B | privileged | 0.02 / 0.14 | 0.02 / 0.05 |
| A+B | worker | 0.03 / 0.04 | 0.03 / 0.06 |
| A-include | privileged | 0.03 / 0.07 | 26 / 26 |
| A-include | worker | 0.04 / 0.10 | 26 / 27 |
| A-include+B | privileged | 0.02 / 0.04 | 0.02 / 0.04 |
| A-include+B | worker | 0.02 / 0.04 | 0.02 / 0.08 |
| B-no-include | privileged | 0.02 / 0.04 | 0.02 / 0.04 |
| B-no-include | worker | 0.02 / 0.04 | 0.02 / 0.04 |
| A+B-no-include | privileged | 0.02 / 0.02 | 0.02 / 0.05 |
| A+B-no-include | worker | 0.02 / 0.04 | 0.02 / 0.04 |

### post-vacuum: index sizes and build times

- baseline: {}; build ms -

- A: {"bench_a":8142848}; build ms 106

- B: {"bench_b":40574976}; build ms 405

- A+B: {"bench_a":8142848,"bench_b":40574976}; build ms 60, 401

- A-include: {"bench_a_inc":13533184}; build ms 85

- A-include+B: {"bench_a_inc":13533184,"bench_b":40574976}; build ms 143, 357

- B-no-include: {"bench_bn":17793024}; build ms 240

- A+B-no-include: {"bench_a":8142848,"bench_bn":17793024}; build ms 57, 240

## Cleanup

```json

{
  "containerGone": true,
  "newDanglingVolumes": []
}

```
