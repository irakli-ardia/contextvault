import { type Email, parseUserId, type UserId } from "@contextvault/domain";
import { eq } from "drizzle-orm";
import type { Database } from "../client";
import { postgresErrorCode } from "../repositories/workspaces/postgres-error";
import { userCredentials, users } from "../schema/index";
import { AccountExists } from "./errors";

const uniqueViolation = "23505";

export interface OwnerAccounts {
  /** Inserts the user, or returns the existing one (`created` false: an interrupted earlier run). */
  claimUser(
    id: UserId,
    email: Email,
  ): Promise<{ id: UserId; created: boolean; hasCredential: boolean }>;
  /** Writing the credential is the last step: it is what makes the account loginable. */
  insertCredential(userId: UserId, passwordHash: string): Promise<void>;
}

// Runs on the owner-role connection, which can write `users` and `user_credentials` (the
// application role cannot) and cannot touch the FORCEd tenant tables.
export function createOwnerAccounts(db: Database): OwnerAccounts {
  return {
    claimUser: (id, email) =>
      db.transaction(async (tx) => {
        const inserted = await tx
          .insert(users)
          .values({ id, email })
          .onConflictDoNothing({ target: users.email })
          .returning({ id: users.id });
        if (inserted.length === 1) return { id, created: true, hasCredential: false };
        const [row] = await tx
          .select({ id: users.id, credential: userCredentials.userId })
          .from(users)
          .leftJoin(userCredentials, eq(userCredentials.userId, users.id))
          .where(eq(users.email, email))
          .limit(1);
        if (row === undefined) throw new Error("User disappeared during provisioning");
        return { id: parseUserId(row.id), created: false, hasCredential: row.credential !== null };
      }),

    async insertCredential(userId, passwordHash) {
      try {
        await db.insert(userCredentials).values({ userId, passwordHash });
      } catch (error) {
        // A concurrent run finished first.
        if (postgresErrorCode(error) === uniqueViolation) throw new AccountExists();
        throw error;
      }
    },
  };
}
