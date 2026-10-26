import {
  type Email,
  parseEmail,
  parseSessionTokenHash,
  parseUserId,
  type SessionTokenHash,
  type UserId,
} from "@contextvault/domain";
import { sql } from "drizzle-orm";
import type { Database, Executor } from "../client";

// The only places that set a presented proof. Each runs one short transaction and sets a
// transaction-local value (is_local = true), so it vanishes at commit or rollback and never
// reaches the next borrower of a pooled connection. Values are re-validated here, not just typed:
// a forged brand still cannot smuggle a hostile string into a setting. Nothing network-bound or
// slow (hashing) belongs inside `work`.

export function withLoginProof<T>(
  db: Database,
  email: Email,
  work: (tx: Executor) => Promise<T>,
): Promise<T> {
  const proof = parseEmail(email);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.login_email', ${proof}, true)`);
    return work(tx);
  });
}

export function withSessionProof<T>(
  db: Database,
  tokenHash: SessionTokenHash,
  work: (tx: Executor) => Promise<T>,
): Promise<T> {
  const proof = parseSessionTokenHash(tokenHash);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.session_token_hash', ${proof}, true)`);
    return work(tx);
  });
}

// A user already proven by the caller (a verified login), for the user's own session rows. It
// sets only the user id: no workspace claim, so no tenant table is reachable through it.
export function withUserContext<T>(
  db: Database,
  userId: UserId,
  work: (tx: Executor) => Promise<T>,
): Promise<T> {
  const proof = parseUserId(userId);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${proof}, true)`);
    return work(tx);
  });
}
