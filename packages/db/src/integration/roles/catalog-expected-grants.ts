// The reviewed application-role privileges, table → grants. "PRIV" is table-level; "PRIV(col)" is
// column-only. A table or sequence missing here must have no grants, so a new table fails closed
// until a reviewer lists what it may do.
export const EXPECTED_GRANTS: Record<string, readonly string[]> = {
  "public.workspaces": ["SELECT", "INSERT"],
  "public.memberships": ["SELECT", "INSERT"],
  "public.users": ["SELECT"],
  "public.user_credentials": ["SELECT", "UPDATE(password_hash)", "UPDATE(password_changed_at)"],
  // token_hash is deliberately unreadable: the policies compare it without the caller holding SELECT.
  "public.sessions": [
    "INSERT",
    "DELETE",
    ...["id", "user_id", "created_at", "last_seen_at", "expires_at", "revoked_at"].map(
      (c) => `SELECT(${c})`,
    ),
    "UPDATE(last_seen_at)",
    "UPDATE(revoked_at)",
  ],
  // M1.7 delete command (migration 0017): the soft delete and the closing of the versions; M1.8b
  // retry (migration 0019) adds UPDATE(attempt) so a manual retry can reset the budget. Nothing wider.
  "public.documents": ["SELECT", "INSERT", "UPDATE(deleted_at)", "UPDATE(active_version_id)"],
  "public.document_versions": [
    "SELECT",
    "INSERT",
    ...[
      "status",
      "error_stage",
      "error_code",
      "error_retryable",
      "lease_generation",
      "attempt",
      "updated_at",
    ].map((c) => `UPDATE(${c})`),
  ],
  "public.pending_uploads": ["SELECT", "INSERT", "DELETE"],
  "public.sections": [], // derived rows: worker-written, no application access until M2
  "public.chunks": [],
  // Insert only, and not available_at, dispatched_at or created_at: an entry is always due and live.
  "public.outbox": ["id", "workspace_id", "version_id", "kind"].map((c) => `INSERT(${c})`),
};

// The ingestion worker (migration 0008): lifecycle metadata of document_versions only (no storage
// key, no error text), the deleted flag of documents, and the outbox. Same fail-closed rule: a
// table missing here must have no grants for the worker.
export const WORKER_EXPECTED_GRANTS: Record<string, readonly string[]> = {
  "public.document_versions": [
    ...[
      "id",
      "workspace_id",
      "document_id",
      "status",
      "lease_generation",
      "attempt",
      "updated_at",
      "version_no",
    ].map((c) => `SELECT(${c})`),
    ...[
      "status",
      "lease_generation",
      "attempt",
      "error_stage",
      "error_code",
      "error_retryable",
      "updated_at",
    ].map((c) => `UPDATE(${c})`),
  ],
  "public.documents": [
    "SELECT(id)",
    "SELECT(workspace_id)",
    "SELECT(deleted_at)",
    "SELECT(purged_at)",
    "UPDATE(active_version_id)",
    "UPDATE(purged_at)",
  ],
  "public.outbox": ["SELECT", "INSERT", "UPDATE(dispatched_at)"],
  // Written once by the M1.6 activation and removed only by the M1.7 purge (migration 0018, rows of
  // deleted documents); no update, and no read beyond what the policies and the DELETE predicate need.
  "public.sections": ["INSERT", "DELETE", "SELECT(workspace_id)", "SELECT(version_id)"],
  "public.chunks": ["INSERT", "DELETE", "SELECT(id)", "SELECT(workspace_id)", "SELECT(version_id)"],
};
