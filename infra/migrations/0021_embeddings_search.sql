CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_id_workspace_version_unique" UNIQUE("id","workspace_id","version_id");--> statement-breakpoint
CREATE TABLE "chunk_embeddings" (
	"chunk_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"model" text NOT NULL,
	"embedding" vector(1536) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chunk_embeddings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chunk_embeddings" ADD CONSTRAINT "chunk_embeddings_chunk_fk" FOREIGN KEY ("chunk_id","workspace_id","version_id") REFERENCES "public"."chunks"("id","workspace_id","version_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chunk_embeddings_workspace_model_idx" ON "chunk_embeddings" USING btree ("workspace_id","model");--> statement-breakpoint
CREATE POLICY "chunks_app_select" ON "chunks" AS PERMISSIVE FOR SELECT TO "contextvault_app" USING ("chunks"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid and exists (
    select 1 from "memberships" m
    where m.workspace_id = "chunks"."workspace_id" and m.user_id = nullif(current_setting('app.user_id', true), '')::uuid));--> statement-breakpoint
CREATE POLICY "chunk_embeddings_worker_insert" ON "chunk_embeddings" AS PERMISSIVE FOR INSERT TO "contextvault_worker" WITH CHECK ("chunk_embeddings"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid and exists (select 1 from "document_versions" v
    where v.id = "chunk_embeddings"."version_id" and v.workspace_id = "chunk_embeddings"."workspace_id" and v.status = 'chunking'));--> statement-breakpoint
CREATE POLICY "chunk_embeddings_app_select" ON "chunk_embeddings" AS PERMISSIVE FOR SELECT TO "contextvault_app" USING ("chunk_embeddings"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid and exists (
    select 1 from "memberships" m
    where m.workspace_id = "chunk_embeddings"."workspace_id" and m.user_id = nullif(current_setting('app.user_id', true), '')::uuid));--> statement-breakpoint
-- Custom (M2): drizzle-kit emits the table, policies and constraints, not FORCE, grants, the
-- extension or the trigger below.
-- Retrieval reads. The application role may read the evidence columns of chunks (no hashes, no
-- strategy details) and the vectors, bound to its workspace and membership by the policies. The
-- search query adds the rest of the authorization itself: live document, active version, `ready`.
-- The worker writes a vector only for a chunk of a version still being chunked (policy), in the
-- activation transaction.
ALTER TABLE "chunk_embeddings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "chunk_embeddings" FROM PUBLIC;--> statement-breakpoint
GRANT INSERT ON "chunk_embeddings" TO "contextvault_worker";--> statement-breakpoint
GRANT SELECT ON "chunk_embeddings" TO "contextvault_app";--> statement-breakpoint
GRANT SELECT ("id", "workspace_id", "version_id", "content", "start_offset", "end_offset") ON "chunks" TO "contextvault_app";--> statement-breakpoint
-- Worker lifecycle state machine. Until now the worker's UPDATE policy only checked a write's
-- result, so a holder of the runtime credential could set `ready` from any state, revert a `ready`
-- version, or mark a deleted document's version `ready`. Retrieval trusts `ready`, so the legal
-- transitions are now enforced in the database for the two runtime roles (the same table is
-- written by the application role's retry and delete commands). Mirrors packages/domain
-- ingestion/lifecycle.ts plus the manual retry (failed -> queued). `ready`, `processed` and
-- `failed` are otherwise terminal; `ready` is reachable only from `chunking`, for a live document.
-- The owner (migrations, fixtures) is not constrained. Not a lease check: fencing stays in the
-- statements.
CREATE FUNCTION "document_versions_guard_status"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status
     OR current_user NOT IN ('contextvault_worker', 'contextvault_app') THEN
    RETURN NEW;
  END IF;
  IF NOT ((OLD.status, NEW.status) IN (
    ('uploaded', 'queued'), ('uploaded', 'parsing'), ('uploaded', 'failed'),
    ('queued', 'parsing'), ('queued', 'failed'),
    ('parsing', 'chunking'), ('parsing', 'queued'), ('parsing', 'failed'),
    ('chunking', 'ready'), ('chunking', 'queued'), ('chunking', 'failed'),
    ('failed', 'queued'))) THEN
    RAISE EXCEPTION 'illegal document_versions status transition' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'ready' AND NOT EXISTS (
    SELECT 1 FROM public.documents d
    WHERE d.id = NEW.document_id AND d.workspace_id = NEW.workspace_id AND d.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'a version of a deleted document cannot become ready' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "document_versions_guard_status" BEFORE UPDATE OF "status" ON "document_versions"
  FOR EACH ROW EXECUTE FUNCTION "document_versions_guard_status"();
