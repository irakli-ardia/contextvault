-- Custom: drizzle-kit emits ENABLE ROW LEVEL SECURITY and the policies but not FORCE or grants.
-- The application role gets the least privilege M1.3c needs:
--   documents, document_versions: SELECT and INSERT only. Rows are append-only, so a finalized
--     document or version cannot be altered or removed through the application. The M1.4 state
--     machine will be granted UPDATE on the lifecycle columns of document_versions, nothing wider.
--   pending_uploads: SELECT, INSERT, and DELETE (the policy limits DELETE to the creator's rows).
ALTER TABLE "documents" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_versions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pending_uploads" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "documents", "document_versions", "pending_uploads" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON "documents", "document_versions" TO "contextvault_app";--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "pending_uploads" TO "contextvault_app";
