CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "sessions_token_hash_length" CHECK (octet_length("sessions"."token_hash") = 32),
	CONSTRAINT "sessions_expires_after_created" CHECK ("sessions"."expires_at" > "sessions"."created_at")
);
--> statement-breakpoint
ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "user_credentials" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"password_changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_credentials" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_credentials" ADD CONSTRAINT "user_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE POLICY "users_select_login" ON "users" AS PERMISSIVE FOR SELECT TO "contextvault_app" USING ("users"."email" = nullif(current_setting('app.login_email', true), ''));--> statement-breakpoint
CREATE POLICY "sessions_select_proof" ON "sessions" AS PERMISSIVE FOR SELECT TO "contextvault_app" USING ("sessions"."token_hash" = case
  when current_setting('app.session_token_hash', true) ~ '^[0-9a-f]{64}$'
  then decode(current_setting('app.session_token_hash', true), 'hex') end);--> statement-breakpoint
CREATE POLICY "sessions_select_own" ON "sessions" AS PERMISSIVE FOR SELECT TO "contextvault_app" USING ("sessions"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "sessions_insert_own" ON "sessions" AS PERMISSIVE FOR INSERT TO "contextvault_app" WITH CHECK ("sessions"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "sessions_update_proof" ON "sessions" AS PERMISSIVE FOR UPDATE TO "contextvault_app" USING ("sessions"."token_hash" = case
  when current_setting('app.session_token_hash', true) ~ '^[0-9a-f]{64}$'
  then decode(current_setting('app.session_token_hash', true), 'hex') end) WITH CHECK ("sessions"."token_hash" = case
  when current_setting('app.session_token_hash', true) ~ '^[0-9a-f]{64}$'
  then decode(current_setting('app.session_token_hash', true), 'hex') end);--> statement-breakpoint
CREATE POLICY "sessions_update_own" ON "sessions" AS PERMISSIVE FOR UPDATE TO "contextvault_app" USING ("sessions"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("sessions"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "sessions_delete_own_dead" ON "sessions" AS PERMISSIVE FOR DELETE TO "contextvault_app" USING ("sessions"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid
        and ("sessions"."revoked_at" is not null or "sessions"."expires_at" <= now()));--> statement-breakpoint
CREATE POLICY "user_credentials_select_login" ON "user_credentials" AS PERMISSIVE FOR SELECT TO "contextvault_app" USING (exists (
      select 1 from "users" u where u.id = "user_credentials"."user_id" and u.email = nullif(current_setting('app.login_email', true), '')));--> statement-breakpoint
CREATE POLICY "user_credentials_update_login" ON "user_credentials" AS PERMISSIVE FOR UPDATE TO "contextvault_app" USING (exists (
      select 1 from "users" u where u.id = "user_credentials"."user_id" and u.email = nullif(current_setting('app.login_email', true), ''))) WITH CHECK (exists (
      select 1 from "users" u where u.id = "user_credentials"."user_id" and u.email = nullif(current_setting('app.login_email', true), '')));