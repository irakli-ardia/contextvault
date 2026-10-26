import { sql } from "drizzle-orm";
import { check, pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { appRole, currentUserId, loginEmail } from "./rls";

// Platform-owned (no workspace_id). RLS is enabled but not forced on purpose: the owner role
// creates accounts (the M1.2 create-user command) and must not be filtered by a policy that only
// speaks about the application role. The application role is not the owner, so RLS binds it: it
// sees its own row (or the one row whose email it presents as the login proof), and has no INSERT,
// UPDATE, or DELETE grant.
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey(),
    email: text("email").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("users_email_lowercase", sql`${table.email} = lower(${table.email})`),
    pgPolicy("users_select_self", {
      for: "select",
      to: appRole,
      using: sql`${table.id} = ${currentUserId}`,
    }),
    pgPolicy("users_select_login", {
      for: "select",
      to: appRole,
      using: sql`${table.email} = ${loginEmail}`,
    }),
  ],
).enableRLS();
