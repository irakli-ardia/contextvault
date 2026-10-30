CREATE TABLE "outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_kind" CHECK ("outbox"."kind" in ('process_version'))
);
--> statement-breakpoint
ALTER TABLE "outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_versions" DROP CONSTRAINT "document_versions_status";--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_workspace_id_id_unique" UNIQUE("workspace_id","id");--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_workspace_version_fk" FOREIGN KEY ("workspace_id","version_id") REFERENCES "public"."document_versions"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_workspace_version_live_idx" ON "outbox" USING btree ("workspace_id","version_id") WHERE "outbox"."dispatched_at" is null;--> statement-breakpoint
CREATE INDEX "outbox_pending_available_idx" ON "outbox" USING btree ("available_at") WHERE "outbox"."dispatched_at" is null;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_status" CHECK ("document_versions"."status" in ('uploaded', 'queued', 'parsing', 'chunking', 'processed', 'ready', 'failed'));--> statement-breakpoint
CREATE POLICY "document_versions_worker_discover" ON "document_versions" AS PERMISSIVE FOR SELECT TO "contextvault_worker" USING (true);--> statement-breakpoint
CREATE POLICY "document_versions_worker_update" ON "document_versions" AS PERMISSIVE FOR UPDATE TO "contextvault_worker" USING ("document_versions"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK ("document_versions"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid and "document_versions"."status" <> 'ready');--> statement-breakpoint
CREATE POLICY "documents_worker_select" ON "documents" AS PERMISSIVE FOR SELECT TO "contextvault_worker" USING ("documents"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "outbox_worker_discover" ON "outbox" AS PERMISSIVE FOR SELECT TO "contextvault_worker" USING (true);--> statement-breakpoint
CREATE POLICY "outbox_worker_insert" ON "outbox" AS PERMISSIVE FOR INSERT TO "contextvault_worker" WITH CHECK ("outbox"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "outbox_worker_mark" ON "outbox" AS PERMISSIVE FOR UPDATE TO "contextvault_worker" USING ("outbox"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK ("outbox"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);