import type { SessionId, UserId } from "../kernel/ids";

// Deliberately has no token or token-hash field: the hash is a lookup key held by the store.
export interface Session {
  readonly id: SessionId;
  readonly userId: UserId;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

const minute = 60_000;
export const sessionLifetime = {
  absoluteMs: 7 * 24 * 60 * minute,
  idleMs: 24 * 60 * minute,
  // last_seen_at is written at most this often, so idle accuracy is this coarse.
  touchIntervalMs: 5 * minute,
} as const;

export function newSession(id: SessionId, userId: UserId, now: Date): Session {
  return {
    id,
    userId,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: new Date(now.getTime() + sessionLifetime.absoluteMs),
    revokedAt: null,
  };
}

// Both limits are exclusive: at the exact boundary instant the session is already over.
export function isSessionActive(session: Session, now: Date): boolean {
  return (
    session.revokedAt === null &&
    now.getTime() < session.expiresAt.getTime() &&
    now.getTime() < session.lastSeenAt.getTime() + sessionLifetime.idleMs
  );
}

export function needsTouch(session: Session, now: Date): boolean {
  return now.getTime() - session.lastSeenAt.getTime() >= sessionLifetime.touchIntervalMs;
}
