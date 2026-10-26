CREATE TABLE "memberships" (
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id"),
	CONSTRAINT "memberships_role" CHECK ("memberships"."role" in ('owner', 'admin', 'member'))
);
--> statement-breakpoint
ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_email_lowercase" CHECK ("users"."email" = lower("users"."email"))
);
--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_name_length" CHECK (char_length("workspaces"."name") between 1 and 120)
);
--> statement-breakpoint
ALTER TABLE "workspaces" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memberships_user_id_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE POLICY "memberships_select_own" ON "memberships" AS PERMISSIVE FOR SELECT TO "contextvault_app" USING ("memberships"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid
        and (nullif(current_setting('app.workspace_id', true), '')::uuid is null or "memberships"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid));--> statement-breakpoint
CREATE POLICY "memberships_insert" ON "memberships" AS PERMISSIVE FOR INSERT TO "contextvault_app" WITH CHECK ((nullif(current_setting('app.workspace_id', true), '')::uuid is null or "memberships"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid)
        and (
          ("memberships"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid and "memberships"."role" = 'owner' and exists (
            select 1 from "workspaces" w
            where w.id = "memberships"."workspace_id"
              and w.created_by = nullif(current_setting('app.user_id', true), '')::uuid and w.created_at = now()))
          or exists (
            select 1 from "memberships" actor
            where actor.workspace_id = "memberships"."workspace_id" and actor.user_id = nullif(current_setting('app.user_id', true), '')::uuid
              and (actor.role = 'owner' or (actor.role = 'admin' and "memberships"."role" <> 'owner')))
        ));--> statement-breakpoint
CREATE POLICY "users_select_self" ON "users" AS PERMISSIVE FOR SELECT TO "contextvault_app" USING ("users"."id" = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "workspaces_select_member" ON "workspaces" AS PERMISSIVE FOR SELECT TO "contextvault_app" USING ((nullif(current_setting('app.workspace_id', true), '')::uuid is null or "workspaces"."id" = nullif(current_setting('app.workspace_id', true), '')::uuid)
        and (
          exists (select 1 from "memberships" m
            where m.workspace_id = "workspaces"."id" and m.user_id = nullif(current_setting('app.user_id', true), '')::uuid)
          or ("workspaces"."created_by" = nullif(current_setting('app.user_id', true), '')::uuid and "workspaces"."created_at" = now())
        ));--> statement-breakpoint
CREATE POLICY "workspaces_insert_creator" ON "workspaces" AS PERMISSIVE FOR INSERT TO "contextvault_app" WITH CHECK ("workspaces"."created_by" = nullif(current_setting('app.user_id', true), '')::uuid
        and (nullif(current_setting('app.workspace_id', true), '')::uuid is null or "workspaces"."id" = nullif(current_setting('app.workspace_id', true), '')::uuid));