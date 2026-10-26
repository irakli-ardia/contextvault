import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { appRole, currentUserId, currentWorkspaceId } from "./rls";
import { users } from "./users";
import { workspaces } from "./workspaces";

// Membership is the proof of access: a caller sees only its own rows, so naming a workspace id in
// the context grants nothing without a row here for the asserted user. Inserts are either the
// creator's owner row in the creating transaction, or an owner/admin adding someone (only an
// owner may add an owner). No update or delete grant exists in M1.1.
export const memberships = pgTable(
  "memberships",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    role: text("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.userId] }),
    index("memberships_user_id_idx").on(table.userId),
    check("memberships_role", sql`${table.role} in ('owner', 'admin', 'member')`),
    pgPolicy("memberships_select_own", {
      for: "select",
      to: appRole,
      using: sql`${table.userId} = ${currentUserId}
        and (${currentWorkspaceId} is null or ${table.workspaceId} = ${currentWorkspaceId})`,
    }),
    pgPolicy("memberships_insert", {
      for: "insert",
      to: appRole,
      withCheck: sql`(${currentWorkspaceId} is null or ${table.workspaceId} = ${currentWorkspaceId})
        and (
          (${table.userId} = ${currentUserId} and ${table.role} = 'owner' and exists (
            select 1 from ${workspaces} w
            where w.id = ${table.workspaceId}
              and w.created_by = ${currentUserId} and w.created_at = now()))
          or exists (
            select 1 from "memberships" actor
            where actor.workspace_id = ${table.workspaceId} and actor.user_id = ${currentUserId}
              and (actor.role = 'owner' or (actor.role = 'admin' and ${table.role} <> 'owner')))
        )`,
    }),
  ],
).enableRLS();
