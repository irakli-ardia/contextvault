import { type CredentialStore, parseEmail, parseUserId, type User } from "@contextvault/domain";
import { eq } from "drizzle-orm";
import type { Database } from "../client";
import { userCredentials, users } from "../schema/index";
import { withLoginProof } from "./proofs";

// Under the login proof the policies expose exactly the presented email's user and credential;
// the explicit `where` is a second fence, not the only one.
export function createCredentialStore(db: Database): CredentialStore {
  return {
    findByEmail: (email) =>
      withLoginProof(db, email, async (tx) => {
        const [row] = await tx
          .select({
            id: users.id,
            email: users.email,
            passwordHash: userCredentials.passwordHash,
          })
          .from(users)
          .innerJoin(userCredentials, eq(userCredentials.userId, users.id))
          .where(eq(users.email, email))
          .limit(1);
        if (row === undefined) return null;
        return {
          user: { id: parseUserId(row.id), email: parseEmail(row.email) },
          passwordHash: row.passwordHash,
        };
      }),

    updatePasswordHash: (user: User, passwordHash, now) =>
      withLoginProof(db, user.email, async (tx) => {
        const rows = await tx
          .update(userCredentials)
          .set({ passwordHash, passwordChangedAt: now })
          .where(eq(userCredentials.userId, user.id))
          .returning({ userId: userCredentials.userId });
        return rows.length === 1;
      }),
  };
}
