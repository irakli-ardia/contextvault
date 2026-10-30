-- Custom: lets the dispatcher push a failing outbox entry back (`available_at`) so it cannot starve
-- newer work. Column-level, like the other worker grants: dispatched_at stays the only other
-- writable column and the UPDATE policy still binds the row to the asserted workspace.
GRANT UPDATE ("available_at") ON "outbox" TO "contextvault_worker";
