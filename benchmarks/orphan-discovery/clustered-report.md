# Orphan discovery, clustered backlog (generated)

Run 2026-11-09T05:24:15.888Z to 2026-11-09T05:31:04.494Z. Image `pgvector/pgvector:0.8.7-pg18@sha256:2358fcba361ed2233a5ed81b5fe4ca779ccb304120ce531a3bf51c0ed7e2bc11`, server_version_num 180006, 127.0.0.1:53974, tmpfs only. Migrations: 13. Waiting versions per dataset: 200000; page size 500; role worker (statement_timeout 15s); post-VACUUM only.

Settings: {"autovacuum":"off","effective_cache_size":"524288","fsync":"off","jit":"on","max_parallel_workers_per_gather":"2","random_page_cost":"4","shared_buffers":"32768","work_mem":"4096"}. Targets (predefined engineering targets, not guarantees): {"pageMs":1500,"controlHeadMs":10,"perCandidateFactor":3,"c3VsC2Median":1.1,"c3VsC2Single":1.5,"c3VsC2MinDiffMs":10,"near":1.2}.

## Verdict: PASS

| criterion | verdict | detail |
|---|---|---|
| P1 | PASS | `{"detail":[]}` |
| P2 | PASS | `{"detail":[],"review":["control/tail: no nested loop under the limit"]}` |
| P3 | PASS | `{}` |
| P4 | PASS | `{"controlUsPerCandidate":5.845594021321024}` |
| P5 | PASS | `{"pairs":30,"medianRatio":0.13071709357224726,"slow":[]}` |
| V4 | PASS | `{"invalid":[],"inconclusive":[],"notApplicable":["control/C3/tail: no nested loop under the limit"]}` |

P6 (informational): C0 on the control [["page-1","timeout",null],["mid-50","timeout",null],["tail","ok",3430.297]]; committed A+B-no-include post-VACUUM worker range 2.22-2.31 ms (original run, possibly other conditions); C3 on the control 3.94 ms = 1.71-1.77x the committed range.

## Dataset validation (V1/V2/V3)

| dataset | tables+indexes (C0 state) | problems |
|---|---|---|
| control | 392 MB | none |
| live | 421 MB | none |
| cooldown | 453 MB | none |
| mixed | 437 MB | none |
| wide | 472 MB | none |

Expected counts come from the seed's class map; the database counts are compared with them above. Whether a dataset fits in `shared_buffers` is not assumed: see the hit/read figures per run.

```json

[
  {
    "key": "control",
    "clusters": [],
    "counts": {
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
      "outbox_rows": 687002
    }
  },
  {
    "key": "live",
    "clusters": [
      {
        "name": "F",
        "lo": 0,
        "hi": 20000,
        "kind": "live"
      },
      {
        "name": "D",
        "lo": 110000,
        "hi": 130000,
        "kind": "live"
      }
    ],
    "counts": {
      "waiting": 200000,
      "with_live_outbox": 64000,
      "attempts_exhausted": 6400,
      "in_cooldown": 16000,
      "deleted_document": 11200,
      "history_ge_11": 6400,
      "max_history": 14,
      "workspaces": 20,
      "documents": 265000,
      "versions": 265000,
      "outbox_rows": 662623
    }
  },
  {
    "key": "cooldown",
    "clusters": [
      {
        "name": "F",
        "lo": 0,
        "hi": 20000,
        "kind": "cooldown"
      },
      {
        "name": "D",
        "lo": 110000,
        "hi": 130000,
        "kind": "cooldown"
      }
    ],
    "counts": {
      "waiting": 200000,
      "with_live_outbox": 24000,
      "attempts_exhausted": 6400,
      "in_cooldown": 56000,
      "deleted_document": 11200,
      "history_ge_11": 6400,
      "max_history": 14,
      "workspaces": 20,
      "documents": 265000,
      "versions": 265000,
      "outbox_rows": 882623
    }
  },
  {
    "key": "mixed",
    "clusters": [
      {
        "name": "F",
        "lo": 0,
        "hi": 20000,
        "kind": "mixed"
      },
      {
        "name": "D",
        "lo": 110000,
        "hi": 130000,
        "kind": "mixed"
      }
    ],
    "counts": {
      "waiting": 200000,
      "with_live_outbox": 44000,
      "attempts_exhausted": 6400,
      "in_cooldown": 36000,
      "deleted_document": 11200,
      "history_ge_11": 6400,
      "max_history": 14,
      "workspaces": 20,
      "documents": 265000,
      "versions": 265000,
      "outbox_rows": 762623
    }
  },
  {
    "key": "wide",
    "clusters": [
      {
        "name": "W",
        "lo": 10000,
        "hi": 160000,
        "kind": "mixed"
      }
    ],
    "counts": {
      "waiting": 200000,
      "with_live_outbox": 82500,
      "attempts_exhausted": 2000,
      "in_cooldown": 80000,
      "deleted_document": 3500,
      "history_ge_11": 2000,
      "max_history": 14,
      "workspaces": 20,
      "documents": 265000,
      "versions": 265000,
      "outbox_rows": 970506
    }
  }
]

```

## control: execution time (median of timed runs)

| scenario | C0 | C1 | C2 | C3 |
|---|---|---|---|---|
| page-1 | TIMEOUT, at least the statement timeout (est. cost 30176568) | TIMEOUT, at least the statement timeout (est. cost 30156903) | 54 ms, 80.01 us/cand, hit 10955/read 0 | 4.14 ms, 6.14 us/cand, hit 3537/read 0 |
| mid-50 | TIMEOUT, at least the statement timeout (est. cost 30170966) | TIMEOUT, at least the statement timeout (est. cost 30157001) | 37 ms, 54.98 us/cand, hit 10886/read 0 | 3.74 ms, 5.55 us/cand, hit 3528/read 0 |
| tail (incomplete) | 3430 ms, 23988.09 us/cand, hit 1407465/read 0 (JIT) | 3305 ms, 23111.41 us/cand, hit 1399551/read 0 (JIT) | 21 ms, 147.41 us/cand, hit 8666/read 0 | 0.78 ms, 5.48 us/cand, hit 752/read 0 |

## live: execution time (median of timed runs)

| scenario | C0 | C1 | C2 | C3 |
|---|---|---|---|---|
| F-entry | - | - | 133 ms, 6.41 us/cand, hit 111108/read 0 | 101 ms, 4.90 us/cand, hit 123789/read 0 |
| F-interior | - | - | 94 ms, 8.80 us/cand, hit 60965/read 0 | 53 ms, 4.92 us/cand, hit 63656/read 0 |
| F-exit | - | - | 52 ms, 66.98 us/cand, hit 11394/read 0 | 3.18 ms, 4.10 us/cand, hit 4136/read 0 |
| F-beyond | - | - | 47 ms, 69.85 us/cand, hit 10902/read 0 | 3.66 ms, 5.42 us/cand, hit 3545/read 0 |
| D-entry | TIMEOUT, at least the statement timeout (est. cost 29051689) | TIMEOUT, at least the statement timeout (est. cost 29038088) | 117 ms, 5.67 us/cand, hit 111036/read 0 | 111 ms, 5.35 us/cand, hit 123778/read 0 |
| D-interior | - | - | 76 ms, 7.14 us/cand, hit 60954/read 0 | 53 ms, 4.95 us/cand, hit 63645/read 0 |
| D-exit | - | - | 33 ms, 43.10 us/cand, hit 11385/read 0 | 2.86 ms, 3.69 us/cand, hit 4128/read 0 |
| D-beyond | - | - | 32 ms, 47.55 us/cand, hit 10895/read 0 | 2.35 ms, 3.47 us/cand, hit 3538/read 0 |

## cooldown: execution time (median of timed runs)

| scenario | C0 | C1 | C2 | C3 |
|---|---|---|---|---|
| F-entry | - | - | 163 ms, 7.87 us/cand, hit 92995/read 0 | 127 ms, 6.15 us/cand, hit 105676/read 0 |
| F-interior | - | - | 107 ms, 9.99 us/cand, hit 51903/read 0 | 64 ms, 5.97 us/cand, hit 54594/read 0 |
| F-exit | - | - | 51 ms, 65.79 us/cand, hit 11307/read 0 | 4.18 ms, 5.40 us/cand, hit 4049/read 0 |
| F-beyond | - | - | 47 ms, 69.49 us/cand, hit 10890/read 0 | 3.44 ms, 5.09 us/cand, hit 3533/read 0 |
| D-entry | TIMEOUT, at least the statement timeout (est. cost 38779213) | TIMEOUT, at least the statement timeout (est. cost 38765629) | 144 ms, 6.96 us/cand, hit 92889/read 0 | 127 ms, 6.16 us/cand, hit 105631/read 0 |
| D-interior | - | - | 89 ms, 8.30 us/cand, hit 51907/read 0 | 67 ms, 6.30 us/cand, hit 54598/read 0 |
| D-exit | - | - | 33 ms, 42.48 us/cand, hit 11307/read 0 | 4.35 ms, 5.62 us/cand, hit 4050/read 0 |
| D-beyond | - | - | 32 ms, 47.51 us/cand, hit 10891/read 0 | 3.27 ms, 4.84 us/cand, hit 3534/read 0 |

## mixed: execution time (median of timed runs)

| scenario | C0 | C1 | C2 | C3 |
|---|---|---|---|---|
| F-entry | - | - | 163 ms, 7.87 us/cand, hit 101942/read 0 | 116 ms, 5.62 us/cand, hit 114623/read 0 |
| F-interior | - | - | 104 ms, 9.71 us/cand, hit 56396/read 0 | 61 ms, 5.75 us/cand, hit 59087/read 0 |
| F-exit | - | - | 47 ms, 61.14 us/cand, hit 11350/read 0 | 4.40 ms, 5.67 us/cand, hit 4092/read 0 |
| F-beyond | - | - | 48 ms, 70.28 us/cand, hit 10896/read 0 | 2.60 ms, 3.84 us/cand, hit 3539/read 0 |
| D-entry | TIMEOUT, at least the statement timeout (est. cost 33475118) | TIMEOUT, at least the statement timeout (est. cost 33460775) | 132 ms, 6.40 us/cand, hit 101902/read 0 | 115 ms, 5.57 us/cand, hit 114644/read 0 |
| D-interior | - | - | 82 ms, 7.72 us/cand, hit 56398/read 0 | 59 ms, 5.54 us/cand, hit 59089/read 0 |
| D-exit | - | - | 32 ms, 41.82 us/cand, hit 11350/read 0 | 3.87 ms, 4.99 us/cand, hit 4093/read 0 |
| D-beyond | - | - | 32 ms, 47.59 us/cand, hit 10891/read 0 | 3.84 ms, 5.68 us/cand, hit 3534/read 0 |

## wide: execution time (median of timed runs)

| scenario | C0 | C1 | C2 | C3 |
|---|---|---|---|---|
| W-entry | TIMEOUT, at least the statement timeout (est. cost 42563625) | TIMEOUT, at least the statement timeout (est. cost 42543935) | 774 ms, 5.14 us/cand, hit 693424/read 0 | 820 ms, 5.44 us/cand, hit 836806/read 0 |
| W-interior | - | - | 402 ms, 5.31 us/cand, hit 352146/read 0 | 430 ms, 5.69 us/cand, hit 420157/read 0 |
| W-exit | - | - | 31 ms, 39.62 us/cand, hit 11348/read 0 | 3.96 ms, 5.12 us/cand, hit 4090/read 0 |
| W-beyond | - | - | 30 ms, 43.68 us/cand, hit 10900/read 0 | 3.49 ms, 5.17 us/cand, hit 3543/read 0 |

## Candidate accounting, C3: plan E/R1/Q/R2/O against the oracle E/R1/Q/R2/O

E examined by the version scan, R1 rejected before the lateral lookup, Q reached it, R2 rejected after it, O returned. Compared only where the plan shape supports it.

| run | plan | oracle | mismatches |
|---|---|---|---|
| control/page-1 | 703/28/675/175/500 | 703/28/675/175/500 | - |
| control/mid-50 | 702/28/674/174/500 | 702/28/674/174/500 | - |
| control/tail | not applicable (incomplete page): no nested loop under the limit | 149/6/143/38/105 | - |
| live/F-entry | 20704/28/20676/20176/500 | 20704/28/20676/20176/500 | - |
| live/F-interior | 10703/28/10675/10175/500 | 10703/28/10675/10175/500 | - |
| live/F-exit | 803/28/775/275/500 | 803/28/775/275/500 | - |
| live/F-beyond | 704/28/676/176/500 | 704/28/676/176/500 | - |
| live/D-entry | 20704/28/20676/20176/500 | 20704/28/20676/20176/500 | - |
| live/D-interior | 10703/28/10675/10175/500 | 10703/28/10675/10175/500 | - |
| live/D-exit | 803/28/775/275/500 | 803/28/775/275/500 | - |
| live/D-beyond | 704/28/676/176/500 | 704/28/676/176/500 | - |
| cooldown/F-entry | 20704/28/20676/20176/500 | 20704/28/20676/20176/500 | - |
| cooldown/F-interior | 10703/28/10675/10175/500 | 10703/28/10675/10175/500 | - |
| cooldown/F-exit | 803/28/775/275/500 | 803/28/775/275/500 | - |
| cooldown/F-beyond | 704/28/676/176/500 | 704/28/676/176/500 | - |
| cooldown/D-entry | 20704/28/20676/20176/500 | 20704/28/20676/20176/500 | - |
| cooldown/D-interior | 10703/28/10675/10175/500 | 10703/28/10675/10175/500 | - |
| cooldown/D-exit | 803/28/775/275/500 | 803/28/775/275/500 | - |
| cooldown/D-beyond | 704/28/676/176/500 | 704/28/676/176/500 | - |
| mixed/F-entry | 20704/28/20676/20176/500 | 20704/28/20676/20176/500 | - |
| mixed/F-interior | 10703/28/10675/10175/500 | 10703/28/10675/10175/500 | - |
| mixed/F-exit | 803/28/775/275/500 | 803/28/775/275/500 | - |
| mixed/F-beyond | 704/28/676/176/500 | 704/28/676/176/500 | - |
| mixed/D-entry | 20704/28/20676/20176/500 | 20704/28/20676/20176/500 | - |
| mixed/D-interior | 10703/28/10675/10175/500 | 10703/28/10675/10175/500 | - |
| mixed/D-exit | 803/28/775/275/500 | 803/28/775/275/500 | - |
| mixed/D-beyond | 704/28/676/176/500 | 704/28/676/176/500 | - |
| wide/W-entry | 150704/28/150676/150176/500 | 150704/28/150676/150176/500 | - |
| wide/W-interior | 75702/28/75674/75174/500 | 75702/28/75674/75174/500 | - |
| wide/W-exit | 802/28/774/274/500 | 802/28/774/274/500 | - |
| wide/W-beyond | 704/28/676/176/500 | 704/28/676/176/500 | - |

## Limits

- Warm runs after a warm-up; cold-cache behaviour, write cost, index-maintenance cost, HOT behaviour and lock duration are not measured.

- One dataset family, one PostgreSQL build, one tmpfs container, no concurrent writes, no `lockOrphan`.

- A repeated run (noise, or C3 within 20% over its budget) is decided by the repeat; the earlier median is in `clustered-results.json`. P4/P5 NEAR is not repeated automatically.

- The plans file holds raw EXPLAIN for every C3 run, one deep entry per dataset for the other configs, and any invalid run or failing plan shape; each is marked comparable, not comparable or timeout.

## Cleanup

```json

{
  "containerGone": true,
  "newDanglingVolumes": []
}

```
