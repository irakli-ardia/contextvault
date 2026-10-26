import { describe, expect, it } from "vitest";
import { parseSessionId, parseUserId } from "../kernel/ids";
import { isSessionActive, needsTouch, newSession, type Session, sessionLifetime } from "./session";

const id = parseSessionId("0b1c9d3e-5a7f-4c2d-8e1f-3a4b5c6d7e8f");
const userId = parseUserId("1b1c9d3e-5a7f-4c2d-8e1f-3a4b5c6d7e8f");
const start = new Date("2026-10-26T12:00:00.000Z");
const at = (ms: number) => new Date(start.getTime() + ms);

describe("session lifetime", () => {
  const session = newSession(id, userId, start);

  it("expires seven days after creation and starts unrevoked", () => {
    expect(session.expiresAt).toEqual(at(sessionLifetime.absoluteMs));
    expect(session.revokedAt).toBeNull();
    expect(session.lastSeenAt).toEqual(start);
  });

  it("is idle-expired exactly at 24 h without activity", () => {
    expect(isSessionActive(session, at(sessionLifetime.idleMs - 1))).toBe(true);
    expect(isSessionActive(session, at(sessionLifetime.idleMs))).toBe(false);
  });

  it("is absolute-expired exactly at 7 d even when recently seen", () => {
    const seen: Session = { ...session, lastSeenAt: at(sessionLifetime.absoluteMs - 1000) };
    expect(isSessionActive(seen, at(sessionLifetime.absoluteMs - 1))).toBe(true);
    expect(isSessionActive(seen, at(sessionLifetime.absoluteMs))).toBe(false);
  });

  it("is inactive once revoked", () => {
    expect(isSessionActive({ ...session, revokedAt: start }, start)).toBe(false);
  });

  it("asks for a touch only after the five-minute interval", () => {
    expect(needsTouch(session, at(sessionLifetime.touchIntervalMs - 1))).toBe(false);
    expect(needsTouch(session, at(sessionLifetime.touchIntervalMs))).toBe(true);
  });
});
