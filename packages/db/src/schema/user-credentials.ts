import { sql } from "drizzle-orm";
import { pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { appRole, loginEmail } from "./rls";
import { users } from "./users";

// Platform-owned. Readable and updatable only under the login proof (the presented email owns the
// row); never under a user context, because nothing needs a user to read their own hash. RLS is
// enabled but not forced, like `users`: the owner role creates accounts and must not be filtered
// by a policy that only speaks about the application role, which is bound as a non-owner.
// WITH CHECK repeats USING so an update cannot move a row out of the proof.
export const userCredentials = pgTable(
  "user_credentials",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    passwordHash: text("password_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    passwordChangedAt: timestamp("password_changed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => {
    const ownedByLoginEmail = sql`exists (
      select 1 from ${users} u where u.id = ${table.userId} and u.email = ${loginEmail})`;
    return [
      pgPolicy("user_credentials_select_login", {
        for: "select",
        to: appRole,
        using: ownedByLoginEmail,
      }),
      pgPolicy("user_credentials_update_login", {
        for: "update",
        to: appRole,
        using: ownedByLoginEmail,
        withCheck: ownedByLoginEmail,
      }),
    ];
  },
).enableRLS();
