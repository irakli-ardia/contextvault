import { sql } from "drizzle-orm";
import { pgRole } from "drizzle-orm/pg-core";

// Created by infra/postgres/init-roles.sh; migrations only grant to it.
export const appRole = pgRole("contextvault_app").existing();

// Transaction-local context set by the unit of work. Unset or empty means NULL, so every
// comparison is NULL and the row is filtered out: policies fail closed.
export const currentUserId = sql`nullif(current_setting('app.user_id', true), '')::uuid`;
export const currentWorkspaceId = sql`nullif(current_setting('app.workspace_id', true), '')::uuid`;

// Presented proofs for the two moments before any user is known. Each is set only by the auth
// stores, after the value is validated, and matches by equality: no pattern, no case folding.
export const loginEmail = sql`nullif(current_setting('app.login_email', true), '')`;
// Malformed hex yields NULL (no row) instead of a decode error; the CASE keeps evaluation order.
export const sessionTokenHash = sql`case
  when current_setting('app.session_token_hash', true) ~ '^[0-9a-f]{64}$'
  then decode(current_setting('app.session_token_hash', true), 'hex') end`;
