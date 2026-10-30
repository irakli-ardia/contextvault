-- Custom: drizzle-kit emits ENABLE ROW LEVEL SECURITY and the policies but not FORCE or grants.
-- contextvault_worker (created by init-roles.sh on a fresh volume, by `infra:roles` on an existing
-- one; migration 0007 already fails without it, because its policies are TO that role) is
-- NOBYPASSRLS and gets the least privilege M1.4 needs:
--   document_versions: column-level SELECT on id, workspace_id, document_id, status,
--     lease_generation, attempt, updated_at (no storage key, no error text, no version number). The
--     discovery policy (0007) is `using (true)`, so these columns are visible across workspaces;
--     they are identifiers, a state and counters. UPDATE on the lifecycle columns only. No INSERT
--     or DELETE: versions are created by the upload path.
--   documents: SELECT on id, workspace_id, deleted_at, restricted by policy to the workspace in
--     context.
--   outbox: table-level SELECT (every column is an id, a kind or a time) and INSERT, and UPDATE of
--     dispatched_at only. No DELETE. Discovery across workspaces is by policy; inserts and marks
--     are bound to the workspace in context.
-- `app.workspace_id` is set by the trusted worker process, not proved to the database: a stolen
-- worker credential can assert any workspace (see docs/threat-model.md).
-- Temporary: the worker's UPDATE policy refuses status `ready` (0007). M1.6 must change the status
-- CHECK, that policy and the pinned policy tests (worker-rls and catalog-invariants) together.
-- The application role gets nothing on outbox yet; the upload increment grants INSERT.
ALTER TABLE "outbox" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "outbox" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT ("id", "workspace_id", "document_id", "status", "lease_generation", "attempt", "updated_at")
  ON "document_versions" TO "contextvault_worker";--> statement-breakpoint
GRANT UPDATE ("status", "lease_generation", "attempt", "error_stage", "error_code", "error_retryable", "updated_at")
  ON "document_versions" TO "contextvault_worker";--> statement-breakpoint
GRANT SELECT ("id", "workspace_id", "deleted_at") ON "documents" TO "contextvault_worker";--> statement-breakpoint
GRANT SELECT, INSERT ON "outbox" TO "contextvault_worker";--> statement-breakpoint
GRANT UPDATE ("dispatched_at") ON "outbox" TO "contextvault_worker";
