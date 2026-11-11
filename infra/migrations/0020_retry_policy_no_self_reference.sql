-- Corrects 0019 (applied to the isolated test database only, never released). Its retry policy
-- read document_versions inside a policy of document_versions ("no newer version"), which
-- PostgreSQL rejects with 42P17 (infinite recursion) for every UPDATE of the table. The clause is
-- removed; the command's own WHERE keeps the retry to the latest version. Nothing else changes.
-- Corrects 0019 (applied to the isolated test database only, never released). Its retry policy
-- read document_versions inside a policy of document_versions ("no newer version"), which
-- PostgreSQL rejects with 42P17 (infinite recursion) for every UPDATE of the table. The clause is
-- removed; the command's own WHERE keeps the retry to the latest version. Nothing else changes.
ALTER POLICY "document_versions_app_retry" ON "document_versions" TO contextvault_app USING ("document_versions"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid and exists (
    select 1 from "memberships" m
    where m.workspace_id = "document_versions"."workspace_id" and m.user_id = nullif(current_setting('app.user_id', true), '')::uuid)
        and "document_versions"."status" = 'failed' and "document_versions"."error_retryable" = true
        and exists (select 1 from "documents" d
          where d.id = "document_versions"."document_id" and d.workspace_id = "document_versions"."workspace_id"
            and d.deleted_at is null)) WITH CHECK ("document_versions"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid and exists (
    select 1 from "memberships" m
    where m.workspace_id = "document_versions"."workspace_id" and m.user_id = nullif(current_setting('app.user_id', true), '')::uuid)
        and "document_versions"."status" = 'queued' and "document_versions"."attempt" = 0
        and "document_versions"."error_stage" is null and "document_versions"."error_code" is null
        and "document_versions"."error_retryable" is null
        and exists (select 1 from "documents" d
          where d.id = "document_versions"."document_id" and d.workspace_id = "document_versions"."workspace_id"
            and d.deleted_at is null));