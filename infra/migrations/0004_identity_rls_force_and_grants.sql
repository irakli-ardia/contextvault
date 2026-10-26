-- Custom: drizzle-kit emits ENABLE ROW LEVEL SECURITY and the policies but not FORCE or grants.
-- FORCE applies to `sessions` only; `user_credentials` follows `users` (not forced) because the
-- owner role creates accounts and the application role is bound as a non-owner.
-- The application role gets the least privilege M1.2a needs:
--   user_credentials: SELECT, and UPDATE of the hash columns (rehash on login). No INSERT or
--     DELETE: accounts are created by the owner role.
--   sessions: SELECT on every column except token_hash, so the hash can never be read back (the
--     policies compare it without the caller holding the privilege); INSERT (table-level, Drizzle
--     names every column); UPDATE of last_seen_at and revoked_at only; DELETE (the policy limits
--     it to the user's own expired or revoked rows).
ALTER TABLE "sessions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "user_credentials", "sessions" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT ON "user_credentials" TO "contextvault_app";--> statement-breakpoint
GRANT UPDATE ("password_hash", "password_changed_at") ON "user_credentials" TO "contextvault_app";--> statement-breakpoint
GRANT SELECT ("id", "user_id", "created_at", "last_seen_at", "expires_at", "revoked_at") ON "sessions" TO "contextvault_app";--> statement-breakpoint
GRANT INSERT ON "sessions" TO "contextvault_app";--> statement-breakpoint
GRANT UPDATE ("last_seen_at", "revoked_at") ON "sessions" TO "contextvault_app";--> statement-breakpoint
GRANT DELETE ON "sessions" TO "contextvault_app";
