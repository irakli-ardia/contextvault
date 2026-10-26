import {
  type Email,
  type PasswordHasher,
  parseEmail,
  parsePassword,
  parseUserId,
} from "@contextvault/domain";
import { and, eq, isNull, sql } from "drizzle-orm";
import { withLoginProof } from "../auth/proofs";
import type { Database } from "../client";
import { sessions, userCredentials, users } from "../schema/index";
import { AccountNotFound, PasswordMismatch } from "./errors";

/** Null when no account has a credential under that email. */
export type CredentialReset = (
  email: Email,
  passwordHash: string,
  now: Date,
) => Promise<{ revokedSessions: number } | null>;

// One transaction on the application role, with no new privilege: the login proof exposes the
// credential for update (the same grant the login rehash uses), and the user's own context lets
// it revoke that user's sessions. The hash and the revocation commit together or not at all. The
// owner role is not used: under FORCE row-level security it cannot see `sessions`.
export function createCredentialReset(db: Database): CredentialReset {
  return (email, passwordHash, now) =>
    withLoginProof(db, email, async (tx) => {
      const [row] = await tx
        .select({ id: users.id })
        .from(users)
        .innerJoin(userCredentials, eq(userCredentials.userId, users.id))
        .where(eq(users.email, email))
        .limit(1);
      if (row === undefined) return null;
      const userId = parseUserId(row.id);
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
      await tx
        .update(userCredentials)
        .set({ passwordHash, passwordChangedAt: now })
        .where(eq(userCredentials.userId, userId));
      const revoked = await tx
        .update(sessions)
        .set({ revokedAt: now })
        .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
        .returning({ id: sessions.id });
      return { revokedSessions: revoked.length };
    });
}

export interface ResetDeps {
  readonly reset: CredentialReset;
  readonly hasher: PasswordHasher;
  readonly now?: () => Date;
}

export async function resetPassword(
  deps: ResetDeps,
  input: { email: string; password: string; confirmation: string },
): Promise<{ email: string; revokedSessions: number }> {
  const email = parseEmail(input.email);
  if (input.password !== input.confirmation) throw new PasswordMismatch();
  const passwordHash = await deps.hasher.hash(parsePassword(input.password));
  const result = await deps.reset(email, passwordHash, (deps.now ?? (() => new Date()))());
  if (result === null) throw new AccountNotFound();
  return { email, revokedSessions: result.revokedSessions };
}
