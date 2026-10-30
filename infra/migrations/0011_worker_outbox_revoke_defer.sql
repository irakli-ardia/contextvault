-- Custom: the dispatcher no longer defers outbox entries (M1.4 increment 4B), so the worker's
-- column grant from 0009 is unused. Revoking it leaves dispatched_at as the only column the worker
-- can update; the UPDATE policy is unchanged. Retry scheduling still inserts a future entry.
REVOKE UPDATE ("available_at") ON "outbox" FROM "contextvault_worker";
