ALTER TABLE "sections" ADD CONSTRAINT "sections_workspace_version_id_unique" UNIQUE("workspace_id","version_id","id");--> statement-breakpoint
ALTER TABLE "chunks" DROP CONSTRAINT "chunks_workspace_section_fk";
--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_workspace_section_fk" FOREIGN KEY ("workspace_id","version_id","section_id") REFERENCES "public"."sections"("workspace_id","version_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "chunks_worker_select" ON "chunks" AS PERMISSIVE FOR SELECT TO "contextvault_worker" USING ("chunks"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "chunks_worker_insert" ON "chunks" TO contextvault_worker WITH CHECK ("chunks"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid and exists (select 1 from "document_versions" v
    where v.id = "chunks"."version_id" and v.workspace_id = "chunks"."workspace_id" and v.status = 'chunking'));--> statement-breakpoint
ALTER POLICY "document_versions_worker_update" ON "document_versions" TO contextvault_worker USING ("document_versions"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK ("document_versions"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid and ("document_versions"."status" <> 'ready' or exists (
        select 1 from "chunks" c where c.version_id = "document_versions"."id" and c.workspace_id = "document_versions"."workspace_id")));--> statement-breakpoint
ALTER POLICY "documents_worker_activate" ON "documents" TO contextvault_worker USING ("documents"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK ("documents"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid and "documents"."deleted_at" is null and exists (
        select 1 from "document_versions" v
        where v.id = "documents"."active_version_id" and v.document_id = "documents"."id"
          and v.workspace_id = "documents"."workspace_id" and v.status = 'ready'
          and not exists (select 1 from "document_versions" n
            where n.document_id = v.document_id and n.workspace_id = v.workspace_id
              and n.status = 'ready' and n.version_no > v.version_no)));--> statement-breakpoint
ALTER POLICY "sections_worker_insert" ON "sections" TO contextvault_worker WITH CHECK ("sections"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid and exists (select 1 from "document_versions" v
    where v.id = "sections"."version_id" and v.workspace_id = "sections"."workspace_id" and v.status = 'chunking'));--> statement-breakpoint
-- Custom grants for the policies above (drizzle-kit emits policies and constraints, not grants).
-- The policy subqueries run with the worker's own privileges, so each column they read is granted
-- here and nothing more: ids of chunks (never `content`) and the version number of a version.
-- Together with the policies this enforces, at write time inside the database (these are write-time
-- checks, not a state machine: a worker credential can still move a version between states): `ready` impossible without chunks,
-- derived rows insertable only while their version is `chunking`, a chunk's section from the same
-- version (foreign key), and an active pointer that names a ready version of the same live
-- document that no newer ready version outranks. Lease fencing stays in the activation statement.
GRANT SELECT ("id", "workspace_id", "version_id") ON "chunks" TO "contextvault_worker";--> statement-breakpoint
GRANT SELECT ("version_no") ON "document_versions" TO "contextvault_worker";
