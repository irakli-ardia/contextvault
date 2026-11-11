-- Custom grants added to the generated policies. M1.7 delete path, application role:
--   documents: UPDATE of deleted_at and active_version_id only (policy documents_app_delete admits
--     only live -> deleted with no active pointer).
--   document_versions: UPDATE of the lifecycle columns the closing writes; policy
--     document_versions_app_close admits only non-terminal versions of an already deleted document
--     becoming failed / document.deleted / not retryable / no stage.
-- Worker grants and policies are unchanged. No DELETE, no physical purge (migration 0018, deferred).
CREATE POLICY "document_versions_app_close" ON "document_versions" AS PERMISSIVE FOR UPDATE TO "contextvault_app" USING ("document_versions"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid and exists (
    select 1 from "memberships" m
    where m.workspace_id = "document_versions"."workspace_id" and m.user_id = nullif(current_setting('app.user_id', true), '')::uuid)
        and "document_versions"."status" in ('uploaded', 'queued', 'parsing', 'chunking')
        and exists (select 1 from "documents" d
          where d.id = "document_versions"."document_id" and d.workspace_id = "document_versions"."workspace_id"
            and d.deleted_at is not null)) WITH CHECK ("document_versions"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid and exists (
    select 1 from "memberships" m
    where m.workspace_id = "document_versions"."workspace_id" and m.user_id = nullif(current_setting('app.user_id', true), '')::uuid) and "document_versions"."status" = 'failed'
        and "document_versions"."error_code" = 'document.deleted' and "document_versions"."error_retryable" = false
        and "document_versions"."error_stage" is null);--> statement-breakpoint
CREATE POLICY "documents_app_delete" ON "documents" AS PERMISSIVE FOR UPDATE TO "contextvault_app" USING ("documents"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid and exists (
    select 1 from "memberships" m
    where m.workspace_id = "documents"."workspace_id" and m.user_id = nullif(current_setting('app.user_id', true), '')::uuid) and "documents"."deleted_at" is null) WITH CHECK ("documents"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid and exists (
    select 1 from "memberships" m
    where m.workspace_id = "documents"."workspace_id" and m.user_id = nullif(current_setting('app.user_id', true), '')::uuid) and "documents"."deleted_at" is not null and "documents"."active_version_id" is null);
--> statement-breakpoint
GRANT UPDATE ("deleted_at", "active_version_id") ON "documents" TO "contextvault_app";--> statement-breakpoint
GRANT UPDATE ("status", "error_stage", "error_code", "error_retryable", "lease_generation", "updated_at") ON "document_versions" TO "contextvault_app";
