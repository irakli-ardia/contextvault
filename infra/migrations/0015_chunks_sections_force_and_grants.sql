-- Custom: drizzle-kit emits ENABLE ROW LEVEL SECURITY and the policies but not FORCE, grants or
-- the foreign key below. M1.6 activation, written by contextvault_worker in one transaction:
--   sections, chunks: INSERT only. No SELECT, UPDATE or DELETE: derived rows are written once by
--     the activation of a version and removed by the M1.7 purge, which needs its own review. The
--     application role gets nothing until retrieval (M2) is reviewed.
--   documents: UPDATE of active_version_id only. deleted_at stays unwritable by every role except
--     the owner until the M1.7 delete path (deletion-grants test).
--   document_versions: the UPDATE policy no longer refuses `ready`; the activation statement is
--     the only code that writes it, fenced by lease generation and by a live document.
-- The worker role's workspace is asserted by the trusted worker, not proved to the database (see
-- docs/threat-model.md); the policies bind every row to the workspace of the job.
ALTER TABLE "sections" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chunks" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "sections" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON "chunks" FROM PUBLIC;--> statement-breakpoint
GRANT INSERT ON "sections" TO "contextvault_worker";--> statement-breakpoint
GRANT INSERT ON "chunks" TO "contextvault_worker";--> statement-breakpoint
GRANT UPDATE ("active_version_id") ON "documents" TO "contextvault_worker";--> statement-breakpoint
-- Stated here, not in the Drizzle schema, because documents.ts and document-versions.ts would
-- import each other. The pair makes an active version of another document impossible. A document
-- with no active version (NULL) is not checked (MATCH SIMPLE).
ALTER TABLE "documents" ADD CONSTRAINT "documents_active_version_fk" FOREIGN KEY ("id","active_version_id") REFERENCES "public"."document_versions"("document_id","id") ON DELETE no action ON UPDATE no action;
