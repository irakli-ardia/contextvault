CREATE TABLE "chunks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"strategy_id" text NOT NULL,
	"strategy_version" integer NOT NULL,
	"ordinal" integer NOT NULL,
	"content" text NOT NULL,
	"content_sha256" "bytea" NOT NULL,
	"token_count" integer NOT NULL,
	"start_offset" integer NOT NULL,
	"end_offset" integer NOT NULL,
	CONSTRAINT "chunks_identity_unique" UNIQUE("version_id","strategy_id","strategy_version","ordinal"),
	CONSTRAINT "chunks_ordinal" CHECK ("chunks"."ordinal" >= 0),
	CONSTRAINT "chunks_strategy_version" CHECK ("chunks"."strategy_version" >= 1),
	CONSTRAINT "chunks_content_nonblank" CHECK ("chunks"."content" ~ '\S'),
	CONSTRAINT "chunks_content_sha256_length" CHECK (octet_length("chunks"."content_sha256") = 32),
	CONSTRAINT "chunks_token_count" CHECK ("chunks"."token_count" >= 1),
	CONSTRAINT "chunks_offsets" CHECK ("chunks"."start_offset" >= 0 and "chunks"."end_offset" > "chunks"."start_offset")
);
--> statement-breakpoint
ALTER TABLE "chunks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"page" integer,
	"start_offset" integer NOT NULL,
	"end_offset" integer NOT NULL,
	CONSTRAINT "sections_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "sections_version_id_ordinal_unique" UNIQUE("version_id","ordinal"),
	CONSTRAINT "sections_ordinal" CHECK ("sections"."ordinal" >= 0),
	CONSTRAINT "sections_page" CHECK ("sections"."page" is null or "sections"."page" >= 1),
	CONSTRAINT "sections_offsets" CHECK ("sections"."start_offset" >= 0 and "sections"."end_offset" >= "sections"."start_offset")
);
--> statement-breakpoint
ALTER TABLE "sections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "active_version_id" uuid;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_workspace_version_fk" FOREIGN KEY ("workspace_id","version_id") REFERENCES "public"."document_versions"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_workspace_section_fk" FOREIGN KEY ("workspace_id","section_id") REFERENCES "public"."sections"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sections" ADD CONSTRAINT "sections_workspace_version_fk" FOREIGN KEY ("workspace_id","version_id") REFERENCES "public"."document_versions"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chunks_workspace_version_idx" ON "chunks" USING btree ("workspace_id","version_id");--> statement-breakpoint
CREATE INDEX "chunks_section_idx" ON "chunks" USING btree ("section_id");--> statement-breakpoint
CREATE INDEX "sections_workspace_version_idx" ON "sections" USING btree ("workspace_id","version_id");--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_id_unique" UNIQUE("document_id","id");--> statement-breakpoint
CREATE POLICY "documents_worker_activate" ON "documents" AS PERMISSIVE FOR UPDATE TO "contextvault_worker" USING ("documents"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK ("documents"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "chunks_worker_insert" ON "chunks" AS PERMISSIVE FOR INSERT TO "contextvault_worker" WITH CHECK ("chunks"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "sections_worker_insert" ON "sections" AS PERMISSIVE FOR INSERT TO "contextvault_worker" WITH CHECK ("sections"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "document_versions_worker_update" ON "document_versions" TO contextvault_worker USING ("document_versions"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK ("document_versions"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);