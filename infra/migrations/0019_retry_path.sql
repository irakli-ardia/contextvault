-- Custom grant and comment added to the generated policies. M1.8b retry path, application role:
--   document_versions: UPDATE(attempt) joins the six lifecycle columns granted in 0017. Policy
--     document_versions_app_retry admits only failed+retryable -> queued with attempt 0 and no
--     recorded failure, for a live document; outbox_app_retry_insert admits the matching outbox
--     entry (INSERT of the four columns from 0010; still no SELECT, UPDATE or DELETE on outbox).
--   document_versions_app_close is tightened to require a deleted document in its WITH CHECK, so
--     the OR-ed policies cannot rewrite a retryable failure of a live document into a closed one.
-- Worker grants and policies are unchanged.
CREATE POLICY "document_versions_app_retry" ON "document_versions" AS PERMISSIVE FOR UPDATE TO "contextvault_app" USING ("document_versions"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid and exists (
    select 1 from "memberships" m
    where m.workspace_id = "document_versions"."workspace_id" and m.user_id = nullif(current_setting('app.user_id', true), '')::uuid)
        and "document_versions"."status" = 'failed' and "document_versions"."error_retryable" = true
        and exists (select 1 from "documents" d
          where d.id = "document_versions"."document_id" and d.workspace_id = "document_versions"."workspace_id"
            and d.deleted_at is null)
        and not exists (select 1 from "document_versions" n
          where n.document_id = "document_versions"."document_id" and n.workspace_id = "document_versions"."workspace_id"
            and n.version_no > "document_versions"."version_no")) WITH CHECK ("document_versions"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid and exists (
    select 1 from "memberships" m
    where m.workspace_id = "document_versions"."workspace_id" and m.user_id = nullif(current_setting('app.user_id', true), '')::uuid)
        and "document_versions"."status" = 'queued' and "document_versions"."attempt" = 0
        and "document_versions"."error_stage" is null and "document_versions"."error_code" is null
        and "document_versions"."error_retryable" is null
        and exists (select 1 from "documents" d
          where d.id = "document_versions"."document_id" and d.workspace_id = "document_versions"."workspace_id"
            and d.deleted_at is null));--> statement-breakpoint
CREATE POLICY "outbox_app_retry_insert" ON "outbox" AS PERMISSIVE FOR INSERT TO "contextvault_app" WITH CHECK ("outbox"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid and exists (
    select 1 from "memberships" m
    where m.workspace_id = "outbox"."workspace_id" and m.user_id = nullif(current_setting('app.user_id', true), '')::uuid) and exists (
        select 1 from "document_versions" v
        join "documents" d on d.id = v.document_id and d.workspace_id = v.workspace_id
        where v.workspace_id = "outbox"."workspace_id" and v.id = "outbox"."version_id"
          and v.status = 'queued' and v.attempt = 0 and d.deleted_at is null));--> statement-breakpoint
ALTER POLICY "document_versions_app_close" ON "document_versions" TO contextvault_app USING ("document_versions"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid and exists (
    select 1 from "memberships" m
    where m.workspace_id = "document_versions"."workspace_id" and m.user_id = nullif(current_setting('app.user_id', true), '')::uuid)
        and "document_versions"."status" in ('uploaded', 'queued', 'parsing', 'chunking')
        and exists (select 1 from "documents" d
          where d.id = "document_versions"."document_id" and d.workspace_id = "document_versions"."workspace_id"
            and d.deleted_at is not null)) WITH CHECK ("document_versions"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid and exists (
    select 1 from "memberships" m
    where m.workspace_id = "document_versions"."workspace_id" and m.user_id = nullif(current_setting('app.user_id', true), '')::uuid) and "document_versions"."status" = 'failed'
        and "document_versions"."error_code" = 'document.deleted' and "document_versions"."error_retryable" = false
        and "document_versions"."error_stage" is null
        and exists (select 1 from "documents" d
          where d.id = "document_versions"."document_id" and d.workspace_id = "document_versions"."workspace_id"
            and d.deleted_at is not null));--> statement-breakpoint
GRANT UPDATE ("attempt") ON "document_versions" TO "contextvault_app";
