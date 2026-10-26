-- drizzle-kit emits ENABLE ROW LEVEL SECURITY and the policies but not FORCE or grants.
-- The application role (created by infra/postgres/init-roles.sh) gets the least privilege M1.1
-- needs: no UPDATE, DELETE, TRUNCATE, or REFERENCES anywhere. INSERT is table-level because
-- Drizzle names every column in its INSERT, defaults included.
ALTER TABLE "workspaces" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memberships" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "users", "workspaces", "memberships" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT ON "users", "workspaces", "memberships" TO "contextvault_app";--> statement-breakpoint
GRANT INSERT ON "workspaces", "memberships" TO "contextvault_app";
