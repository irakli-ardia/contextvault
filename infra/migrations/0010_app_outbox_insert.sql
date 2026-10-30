-- The upload transaction writes the first outbox entry (M1.4 increment 4A). Custom grant appended to
-- the generated policy: the application role gets INSERT on four columns of outbox and nothing
-- else (no SELECT, UPDATE or DELETE; inserts must not use RETURNING). available_at and
-- dispatched_at are not granted, so an entry is always due now and live; created_at is the default.
-- The policy binds the row to the workspace in context, for a member, and to a version of that
-- workspace whose status is still `uploaded`. The composite foreign key (0007) and the worker
-- policies are unchanged.
CREATE POLICY "outbox_app_insert" ON "outbox" AS PERMISSIVE FOR INSERT TO "contextvault_app" WITH CHECK ("outbox"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid and exists (
    select 1 from "memberships" m
    where m.workspace_id = "outbox"."workspace_id" and m.user_id = nullif(current_setting('app.user_id', true), '')::uuid) and exists (
        select 1 from "document_versions" v
        where v.workspace_id = "outbox"."workspace_id" and v.id = "outbox"."version_id"
          and v.status = 'uploaded'));--> statement-breakpoint
GRANT INSERT ("id", "workspace_id", "version_id", "kind") ON "outbox" TO "contextvault_app";
