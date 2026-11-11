ALTER TABLE "documents" ADD COLUMN "purged_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "documents_purge_pending_idx" ON "documents" USING btree ("deleted_at","id") WHERE "documents"."deleted_at" is not null and "documents"."purged_at" is null;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_purged_after_deleted" CHECK ("documents"."purged_at" is null or "documents"."deleted_at" is not null);--> statement-breakpoint
CREATE POLICY "chunks_worker_purge" ON "chunks" AS PERMISSIVE FOR DELETE TO "contextvault_worker" USING ("chunks"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid and exists (select 1 from "document_versions" v
    join "documents" d on d.id = v.document_id and d.workspace_id = v.workspace_id
    where v.id = "chunks"."version_id" and v.workspace_id = "chunks"."workspace_id"
      and d.deleted_at is not null and d.purged_at is null));--> statement-breakpoint
CREATE POLICY "documents_worker_discover_deleted" ON "documents" AS PERMISSIVE FOR SELECT TO "contextvault_worker" USING ("documents"."deleted_at" is not null and "documents"."purged_at" is null);--> statement-breakpoint
CREATE POLICY "documents_worker_purge" ON "documents" AS PERMISSIVE FOR UPDATE TO "contextvault_worker" USING ("documents"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid and "documents"."deleted_at" is not null and "documents"."purged_at" is null) WITH CHECK ("documents"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid and "documents"."deleted_at" is not null
        and "documents"."purged_at" is not null and "documents"."active_version_id" is null
        and not exists (select 1 from "document_versions" v
          where v.document_id = "documents"."id" and v.workspace_id = "documents"."workspace_id"
            and v.status in ('uploaded', 'queued', 'parsing', 'chunking'))
        and not exists (select 1 from "chunks" c
          join "document_versions" v on v.id = c.version_id and v.workspace_id = c.workspace_id
          where v.document_id = "documents"."id" and v.workspace_id = "documents"."workspace_id"));--> statement-breakpoint
CREATE POLICY "sections_worker_select" ON "sections" AS PERMISSIVE FOR SELECT TO "contextvault_worker" USING ("sections"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "sections_worker_purge" ON "sections" AS PERMISSIVE FOR DELETE TO "contextvault_worker" USING ("sections"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid and exists (select 1 from "document_versions" v
    join "documents" d on d.id = v.document_id and d.workspace_id = v.workspace_id
    where v.id = "sections"."version_id" and v.workspace_id = "sections"."workspace_id"
      and d.deleted_at is not null and d.purged_at is null));--> statement-breakpoint
ALTER POLICY "documents_worker_activate" ON "documents" TO contextvault_worker USING ("documents"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid and "documents"."deleted_at" is null) WITH CHECK ("documents"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid and "documents"."deleted_at" is null and exists (
        select 1 from "document_versions" v
        where v.id = "documents"."active_version_id" and v.document_id = "documents"."id"
          and v.workspace_id = "documents"."workspace_id" and v.status = 'ready'
          and not exists (select 1 from "document_versions" n
            where n.document_id = v.document_id and n.workspace_id = v.workspace_id
              and n.status = 'ready' and n.version_no > v.version_no)));--> statement-breakpoint
-- Custom grants for the physical purge (M1.7), worker role only; the application role is unchanged.
-- Nothing deletes documents, versions or outbox rows: the document stays as a tombstone and
-- display_name and content_sha256 are kept until an approved metadata-retention policy exists.
--   documents: discovery reads ids, workspace, deleted_at and purged_at (policy
--     documents_worker_discover_deleted admits deleted, unpurged rows only); the purge sets
--     purged_at (policy documents_worker_purge: nothing left to remove).
--   chunks, sections: DELETE of the rows of a deleted, unpurged document inside the asserted
--     workspace. A DELETE ... WHERE also reads its predicate columns, so sections gain
--     SELECT(workspace_id, version_id) and a workspace-bound read policy; chunks already have both.
GRANT SELECT ("purged_at") ON "documents" TO "contextvault_worker";--> statement-breakpoint
GRANT UPDATE ("purged_at") ON "documents" TO "contextvault_worker";--> statement-breakpoint
GRANT DELETE ON "chunks" TO "contextvault_worker";--> statement-breakpoint
GRANT DELETE ON "sections" TO "contextvault_worker";--> statement-breakpoint
GRANT SELECT ("workspace_id", "version_id") ON "sections" TO "contextvault_worker";
