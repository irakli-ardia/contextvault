import { sql } from "drizzle-orm";
import { check, customType, index, pgPolicy, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { appRole, currentUserId, sessionTokenHash } from "./rls";
import { users } from "./users";

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

// Platform-owned. Only the SHA-256 of the session token is stored. Access is by proof: the
// presented hash selects and updates exactly one row; a user context sees, revokes, and cleans up
// only its own. The application role has no SELECT on token_hash (migration 0004), so the hash
// cannot be read back even by raw SQL. Every UPDATE policy repeats USING as WITH CHECK.
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: bytea("token_hash").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    check("sessions_token_hash_length", sql`octet_length(${table.tokenHash}) = 32`),
    check("sessions_expires_after_created", sql`${table.expiresAt} > ${table.createdAt}`),
    index("sessions_user_id_idx").on(table.userId),
    index("sessions_expires_at_idx").on(table.expiresAt),
    pgPolicy("sessions_select_proof", {
      for: "select",
      to: appRole,
      using: sql`${table.tokenHash} = ${sessionTokenHash}`,
    }),
    pgPolicy("sessions_select_own", {
      for: "select",
      to: appRole,
      using: sql`${table.userId} = ${currentUserId}`,
    }),
    pgPolicy("sessions_insert_own", {
      for: "insert",
      to: appRole,
      withCheck: sql`${table.userId} = ${currentUserId}`,
    }),
    pgPolicy("sessions_update_proof", {
      for: "update",
      to: appRole,
      using: sql`${table.tokenHash} = ${sessionTokenHash}`,
      withCheck: sql`${table.tokenHash} = ${sessionTokenHash}`,
    }),
    pgPolicy("sessions_update_own", {
      for: "update",
      to: appRole,
      using: sql`${table.userId} = ${currentUserId}`,
      withCheck: sql`${table.userId} = ${currentUserId}`,
    }),
    // Only dead rows can be removed, so a wrong code path cannot delete a live session.
    pgPolicy("sessions_delete_own_dead", {
      for: "delete",
      to: appRole,
      using: sql`${table.userId} = ${currentUserId}
        and (${table.revokedAt} is not null or ${table.expiresAt} <= now())`,
    }),
  ],
).enableRLS();
