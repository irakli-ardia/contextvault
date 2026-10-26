import { parseSessionId, parseUserId, type Session, type SessionStore } from "@contextvault/domain";
import { and, eq, isNotNull, isNull, lte, or } from "drizzle-orm";
import type { Database } from "../client";
import { sessions } from "../schema/index";
import { withSessionProof, withUserContext } from "./proofs";

// Never selects token_hash (the application role has no privilege on it) and writes it only on
// insert. The hash is bound as bytes from its validated hex form.
const columns = {
  id: sessions.id,
  userId: sessions.userId,
  createdAt: sessions.createdAt,
  lastSeenAt: sessions.lastSeenAt,
  expiresAt: sessions.expiresAt,
  revokedAt: sessions.revokedAt,
};

function toSession(row: {
  id: string;
  userId: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}): Session {
  return { ...row, id: parseSessionId(row.id), userId: parseUserId(row.userId) };
}

export function createSessionStore(db: Database): SessionStore {
  return {
    async create(session, tokenHash) {
      await withUserContext(db, session.userId, async (tx) => {
        await tx.insert(sessions).values({
          id: session.id,
          userId: session.userId,
          tokenHash: Buffer.from(tokenHash, "hex"),
          createdAt: session.createdAt,
          lastSeenAt: session.lastSeenAt,
          expiresAt: session.expiresAt,
          revokedAt: session.revokedAt,
        });
      });
    },

    // The proof leaves at most one row visible, so no where clause names the hash.
    findByTokenHash: (tokenHash) =>
      withSessionProof(db, tokenHash, async (tx) => {
        const [row] = await tx.select(columns).from(sessions).limit(1);
        return row === undefined ? null : toSession(row);
      }),

    async touch(tokenHash, now) {
      await withSessionProof(db, tokenHash, async (tx) => {
        await tx.update(sessions).set({ lastSeenAt: now }).where(isNull(sessions.revokedAt));
      });
    },

    async revoke(tokenHash, now) {
      await withSessionProof(db, tokenHash, async (tx) => {
        await tx.update(sessions).set({ revokedAt: now }).where(isNull(sessions.revokedAt));
      });
    },

    async revokeAllForUser(userId, now) {
      await withUserContext(db, userId, async (tx) => {
        await tx
          .update(sessions)
          .set({ revokedAt: now })
          .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
      });
    },

    deleteExpiredForUser: (userId, now) =>
      withUserContext(db, userId, async (tx) => {
        const rows = await tx
          .delete(sessions)
          .where(
            and(
              eq(sessions.userId, userId),
              or(isNotNull(sessions.revokedAt), lte(sessions.expiresAt, now)),
            ),
          )
          .returning({ id: sessions.id });
        return rows.length;
      }),
  };
}
