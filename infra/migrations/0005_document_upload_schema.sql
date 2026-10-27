CREATE TABLE "document_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"storage_key" text NOT NULL,
	"status" text DEFAULT 'uploaded' NOT NULL,
	"lease_generation" integer DEFAULT 0 NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"error_stage" text,
	"error_code" text,
	"error_retryable" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_versions_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "document_versions_document_id_version_no_unique" UNIQUE("document_id","version_no"),
	CONSTRAINT "document_versions_version_no" CHECK ("document_versions"."version_no" >= 1),
	CONSTRAINT "document_versions_status" CHECK ("document_versions"."status" in ('uploaded', 'queued', 'parsing', 'chunking', 'ready', 'failed')),
	CONSTRAINT "document_versions_counters" CHECK ("document_versions"."lease_generation" >= 0 and "document_versions"."attempt" >= 0),
	CONSTRAINT "document_versions_storage_key" CHECK ("document_versions"."storage_key" = 'ws/' || "document_versions"."workspace_id"::text || '/doc/' || "document_versions"."document_id"::text || '/v/' || "document_versions"."id"::text)
);
--> statement-breakpoint
ALTER TABLE "document_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"content_sha256" "bytea" NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "documents_display_name_length" CHECK (octet_length("documents"."display_name") between 1 and 255),
	CONSTRAINT "documents_mime" CHECK ("documents"."mime" in ('application/pdf', 'text/markdown', 'text/plain')),
	CONSTRAINT "documents_size_bytes" CHECK ("documents"."size_bytes" between 1 and 10485760),
	CONSTRAINT "documents_content_sha256_length" CHECK (octet_length("documents"."content_sha256") = 32)
);
--> statement-breakpoint
ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pending_uploads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"declared_bytes" integer NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pending_uploads_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "pending_uploads_declared_bytes" CHECK ("pending_uploads"."declared_bytes" between 1 and 10485760),
	CONSTRAINT "pending_uploads_storage_key" CHECK ("pending_uploads"."storage_key" ~ ('^ws/' || "pending_uploads"."workspace_id"::text || '/doc/[0-9a-f-]{36}/v/' || "pending_uploads"."id"::text || '$'))
);
--> statement-breakpoint
ALTER TABLE "pending_uploads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_workspace_document_fk" FOREIGN KEY ("workspace_id","document_id") REFERENCES "public"."documents"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_uploads" ADD CONSTRAINT "pending_uploads_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_uploads" ADD CONSTRAINT "pending_uploads_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_versions_workspace_document_idx" ON "document_versions" USING btree ("workspace_id","document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_workspace_content_live_idx" ON "documents" USING btree ("workspace_id","content_sha256") WHERE "documents"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "documents_workspace_created_idx" ON "documents" USING btree ("workspace_id","created_at" DESC NULLS LAST,"id");--> statement-breakpoint
CREATE INDEX "pending_uploads_workspace_created_idx" ON "pending_uploads" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE POLICY "document_versions_select" ON "document_versions" AS PERMISSIVE FOR SELECT TO "contextvault_app" USING ("document_versions"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid and exists (
    select 1 from "memberships" m
    where m.workspace_id = "document_versions"."workspace_id" and m.user_id = nullif(current_setting('app.user_id', true), '')::uuid));--> statement-breakpoint
CREATE POLICY "document_versions_insert" ON "document_versions" AS PERMISSIVE FOR INSERT TO "contextvault_app" WITH CHECK ("document_versions"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid and exists (
    select 1 from "memberships" m
    where m.workspace_id = "document_versions"."workspace_id" and m.user_id = nullif(current_setting('app.user_id', true), '')::uuid));--> statement-breakpoint
CREATE POLICY "documents_select" ON "documents" AS PERMISSIVE FOR SELECT TO "contextvault_app" USING ("documents"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid and exists (
    select 1 from "memberships" m
    where m.workspace_id = "documents"."workspace_id" and m.user_id = nullif(current_setting('app.user_id', true), '')::uuid));--> statement-breakpoint
CREATE POLICY "documents_insert" ON "documents" AS PERMISSIVE FOR INSERT TO "contextvault_app" WITH CHECK ("documents"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid and exists (
    select 1 from "memberships" m
    where m.workspace_id = "documents"."workspace_id" and m.user_id = nullif(current_setting('app.user_id', true), '')::uuid) and "documents"."created_by" = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pending_uploads_select" ON "pending_uploads" AS PERMISSIVE FOR SELECT TO "contextvault_app" USING ("pending_uploads"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid and exists (
    select 1 from "memberships" m
    where m.workspace_id = "pending_uploads"."workspace_id" and m.user_id = nullif(current_setting('app.user_id', true), '')::uuid));--> statement-breakpoint
CREATE POLICY "pending_uploads_insert" ON "pending_uploads" AS PERMISSIVE FOR INSERT TO "contextvault_app" WITH CHECK ("pending_uploads"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid and exists (
    select 1 from "memberships" m
    where m.workspace_id = "pending_uploads"."workspace_id" and m.user_id = nullif(current_setting('app.user_id', true), '')::uuid) and "pending_uploads"."created_by" = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pending_uploads_delete_own" ON "pending_uploads" AS PERMISSIVE FOR DELETE TO "contextvault_app" USING ("pending_uploads"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid and exists (
    select 1 from "memberships" m
    where m.workspace_id = "pending_uploads"."workspace_id" and m.user_id = nullif(current_setting('app.user_id', true), '')::uuid) and "pending_uploads"."created_by" = nullif(current_setting('app.user_id', true), '')::uuid);