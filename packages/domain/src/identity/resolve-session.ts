import type { SessionId, UserId } from "../kernel/ids";
import { Unauthenticated } from "./errors";
import type { SessionStore } from "./ports";
import { isSessionActive, needsTouch } from "./session";
import type { SessionTokenHash } from "./tokens";

export interface SessionDeps {
  readonly sessions: SessionStore;
  readonly now: () => Date;
}

export interface Identity {
  readonly userId: UserId;
  readonly sessionId: SessionId;
}

/** Identity comes from the stored row alone; a null hash is a missing or malformed token. */
export async function resolveSession(
  deps: SessionDeps,
  tokenHash: SessionTokenHash | null,
): Promise<Identity> {
  if (tokenHash === null) throw new Unauthenticated();
  const session = await deps.sessions.findByTokenHash(tokenHash);
  const now = deps.now();
  if (session === null || !isSessionActive(session, now)) throw new Unauthenticated();
  if (needsTouch(session, now)) await deps.sessions.touch(tokenHash, now);
  return { userId: session.userId, sessionId: session.id };
}

/** Idempotent and silent: an unknown, malformed, or already revoked token is not an error. */
export async function logout(deps: SessionDeps, tokenHash: SessionTokenHash | null): Promise<void> {
  if (tokenHash !== null) await deps.sessions.revoke(tokenHash, deps.now());
}
