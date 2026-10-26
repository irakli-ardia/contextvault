import { sql } from "drizzle-orm";
import { pgRole } from "drizzle-orm/pg-core";

// Created by infra/postgres/init-roles.sh; migrations only grant to it.
export const appRole = pgRole("contextvault_app").existing();

// Transaction-local context set by the unit of work. Unset or empty means NULL, so every
// comparison is NULL and the row is filtered out: policies fail closed.
export const currentUserId = sql`nullif(current_setting('app.user_id', true), '')::uuid`;
export const currentWorkspaceId = sql`nullif(current_setting('app.workspace_id', true), '')::uuid`;
