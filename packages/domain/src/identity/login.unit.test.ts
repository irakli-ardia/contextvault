import { describe, expect, it } from "vitest";
import { HashingBusy, InvalidCredentials, Unauthenticated } from "./errors";
import { fakeDeps, goodPassword, tokenHash, user } from "./fakes";
import { login } from "./login";
import { logout, resolveSession } from "./resolve-session";
import { sessionLifetime } from "./session";

const input = (over: Partial<{ email: string; password: string }> = {}) => ({
  email: "Ada@Example.test ",
  password: goodPassword,
  presentedTokenHash: null,
  ...over,
});

describe("login", () => {
  it("returns the user and a token whose hash is the only thing stored", async () => {
    const f = fakeDeps();
    const result = await login(f.deps, input());
    expect(result).toEqual({ user, token: "token-1" });
    expect([...f.sessions.keys()]).toEqual([tokenHash(1)]);
    expect(JSON.stringify([...f.sessions.values()])).not.toContain("token-1");
  });

  it.each([
    ["unknown email", { email: "nobody@example.test" }],
    ["wrong password", { password: "wrong password here" }],
    ["too-short password", { password: "short" }],
    ["malformed email", { email: "not-an-email" }],
  ])("refuses %s with the same error", async (_name, over) => {
    const f = fakeDeps();
    await expect(login(f.deps, input(over))).rejects.toBeInstanceOf(InvalidCredentials);
    expect(f.sessions.size).toBe(0);
  });

  it("costs one hash verification for unknown email and wrong password alike", async () => {
    const unknown = fakeDeps();
    const wrong = fakeDeps();
    await login(unknown.deps, input({ email: "nobody@example.test" })).catch(() => undefined);
    await login(wrong.deps, input({ password: "wrong password here" })).catch(() => undefined);
    expect(unknown.calls).toEqual(["verify"]);
    expect(wrong.calls).toEqual(["verify"]);
  });

  it("revokes the presented session and issues a different token", async () => {
    const f = fakeDeps();
    const first = await login(f.deps, input());
    const second = await login(f.deps, { ...input(), presentedTokenHash: tokenHash(1) });
    expect(second.token).not.toBe(first.token);
    expect(f.sessions.get(tokenHash(1))?.revokedAt).not.toBeNull();
    expect(f.sessions.get(tokenHash(2))?.revokedAt).toBeNull();
  });

  it("never revokes the presented session when the credentials are wrong", async () => {
    const f = fakeDeps();
    await login(f.deps, input());
    f.calls.length = 0;
    for (const over of [{ password: "wrong password here" }, { email: "nobody@example.test" }]) {
      await expect(
        login(f.deps, { ...input(over), presentedTokenHash: tokenHash(1) }),
      ).rejects.toBeInstanceOf(InvalidCredentials);
    }
    expect(f.calls).not.toContain("revoke");
    expect(f.sessions.get(tokenHash(1))?.revokedAt).toBeNull();
    await expect(resolveSession(f.deps, tokenHash(1))).resolves.toBeDefined();
  });

  it("revokes the presented session only after the password verified", async () => {
    const f = fakeDeps();
    await login(f.deps, input());
    f.calls.length = 0;
    await login(f.deps, { ...input(), presentedTokenHash: tokenHash(1) });
    expect(f.calls).toEqual(["verify", "revoke"]);
  });

  it("issues a token that does not depend on the presented one", async () => {
    const f = fakeDeps();
    const a = await login(f.deps, input());
    const b = await login(f.deps, { ...input(), presentedTokenHash: tokenHash(1) });
    expect(b.token).not.toContain(a.token);
    expect([...f.sessions.keys()]).toEqual([tokenHash(1), tokenHash(2)]);
  });

  it("rehashes a stale hash after a successful verify, and tolerates a busy hasher", async () => {
    const stale = fakeDeps({ stale: true });
    await login(stale.deps, input());
    expect(stale.calls).toEqual(["verify", "rehash"]);

    const busy = fakeDeps({ stale: true, busyOnHash: true });
    await expect(login(busy.deps, input())).resolves.toMatchObject({ user });
  });

  it("propagates a busy hasher during verification so the caller can answer 429", async () => {
    const f = fakeDeps();
    f.deps.hasher.verify = () => Promise.reject(new HashingBusy());
    await expect(login(f.deps, input())).rejects.toBeInstanceOf(HashingBusy);
  });
});

describe("resolveSession and logout", () => {
  async function loggedIn() {
    const f = fakeDeps();
    await login(f.deps, input());
    return f;
  }

  it("resolves identity from the stored row", async () => {
    const f = await loggedIn();
    const row = f.sessions.get(tokenHash(1));
    await expect(resolveSession(f.deps, tokenHash(1))).resolves.toEqual({
      userId: user.id,
      sessionId: row?.id,
    });
  });

  it.each([
    ["null (malformed token)", () => null],
    ["unknown token", () => tokenHash(99)],
  ])("refuses %s", async (_name, pick) => {
    const f = await loggedIn();
    await expect(resolveSession(f.deps, pick())).rejects.toBeInstanceOf(Unauthenticated);
  });

  it("is alive one millisecond before the idle limit and dead at it", async () => {
    const alive = await loggedIn();
    alive.advance(sessionLifetime.idleMs - 1);
    await expect(resolveSession(alive.deps, tokenHash(1))).resolves.toBeDefined();
    const dead = await loggedIn();
    dead.advance(sessionLifetime.idleMs);
    await expect(resolveSession(dead.deps, tokenHash(1))).rejects.toBeInstanceOf(Unauthenticated);
  });

  it("is alive one millisecond before the absolute limit and dead at it, however recently seen", async () => {
    const recentlySeen = async (msBeforeEnd: number) => {
      const f = await loggedIn();
      const row = f.sessions.get(tokenHash(1));
      if (row === undefined) throw new Error("no session");
      f.advance(sessionLifetime.absoluteMs - msBeforeEnd);
      f.sessions.set(tokenHash(1), { ...row, lastSeenAt: f.deps.now() });
      return f;
    };
    const alive = await recentlySeen(1);
    await expect(resolveSession(alive.deps, tokenHash(1))).resolves.toBeDefined();
    const dead = await recentlySeen(0);
    await expect(resolveSession(dead.deps, tokenHash(1))).rejects.toBeInstanceOf(Unauthenticated);
  });

  it("touches at most once per touch interval", async () => {
    const f = await loggedIn();
    f.calls.length = 0;
    await resolveSession(f.deps, tokenHash(1));
    f.advance(sessionLifetime.touchIntervalMs - 1);
    await resolveSession(f.deps, tokenHash(1));
    expect(f.calls).toEqual([]);
    f.advance(1);
    await resolveSession(f.deps, tokenHash(1));
    expect(f.calls).toEqual(["touch"]);
  });

  it("logout revokes, is idempotent, and ignores null and unknown tokens", async () => {
    const f = await loggedIn();
    await logout(f.deps, tokenHash(1));
    await logout(f.deps, tokenHash(1));
    await logout(f.deps, null);
    await logout(f.deps, tokenHash(99));
    await expect(resolveSession(f.deps, tokenHash(1))).rejects.toBeInstanceOf(Unauthenticated);
  });
});
