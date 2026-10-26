import { sql } from "drizzle-orm";
import { check, pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { appRole, currentUserId, currentWorkspaceId } from "./rls";
import { users } from "./users";

// Refers to memberships by name to avoid an import cycle with it.
// Tenant root: `id` is the tenant id. Visible only to its members, narrowed to the workspace in
// context when one is set. The creator also sees the row inside the creating transaction
// (created_at = now()), which is what lets the owner membership be inserted before it exists.
export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("workspaces_name_length", sql`char_length(${table.name}) between 1 and 120`),
    pgPolicy("workspaces_select_member", {
      for: "select",
      to: appRole,
      using: sql`(${currentWorkspaceId} is null or ${table.id} = ${currentWorkspaceId})
        and (
          exists (select 1 from "memberships" m
            where m.workspace_id = ${table.id} and m.user_id = ${currentUserId})
          or (${table.createdBy} = ${currentUserId} and ${table.createdAt} = now())
        )`,
    }),
    pgPolicy("workspaces_insert_creator", {
      for: "insert",
      to: appRole,
      withCheck: sql`${table.createdBy} = ${currentUserId}
        and (${currentWorkspaceId} is null or ${table.id} = ${currentWorkspaceId})`,
    }),
  ],
).enableRLS();
