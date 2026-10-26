import { randomUUID } from "node:crypto";
import {
  isSessionActive,
  newSession,
  parseEmail,
  parseSessionId,
  parseSessionTokenHash,
  type SessionTokenHash,
  type User,
} from "@contextvault/domain";
import { afterAll, describe, expect, it } from "vitest";
import { createTenantFixture } from "./tenant-fixture";

const fx = createTenantFixture(2);
afterAll(() => fx.close());
const { credentials, sessions } = fx.persistence.auth;
const now = new Date();

async function user(): Promise<{ user: User; hash: string }> {
  const id = await fx.seedUser();
  const hash = await fx.seedCredential(id);
  return { user: { id, email: parseEmail(`${id}@test.invalid`) }, hash };
}

const tokenHash = () => parseSessionTokenHash(randomUUID().replaceAll("-", "").repeat(2));
async function login(owner: User, hash: SessionTokenHash = tokenHash()) {
  const session = newSession(parseSessionId(randomUUID()), owner.id, now);
  await sessions.create(session, hash);
  return { session, hash };
}

describe("credential store", () => {
  it("finds the credential of the presented email, and nothing for an unknown one", async () => {
    const a = await user();
    await user();
    expect(await credentials.findByEmail(a.user.email)).toEqual({
      user: a.user,
      passwordHash: a.hash,
    });
    expect(await credentials.findByEmail(parseEmail("nobody@test.invalid"))).toBeNull();
  });

  it("replaces the hash for the matching user only", async () => {
    const [a, b] = [await user(), await user()];
    expect(await credentials.updatePasswordHash(a.user, "$new", now)).toBe(true);
    expect((await credentials.findByEmail(a.user.email))?.passwordHash).toBe("$new");
    expect((await credentials.findByEmail(b.user.email))?.passwordHash).toBe(b.hash);
    // A user id that does not belong to the proven email updates nothing.
    expect(
      await credentials.updatePasswordHash({ ...b.user, email: a.user.email }, "$evil", now),
    ).toBe(false);
    expect((await credentials.findByEmail(b.user.email))?.passwordHash).toBe(b.hash);
  });
});

describe("session store", () => {
  it("creates and finds a session without exposing the hash", async () => {
    const { user: u } = await user();
    const { session, hash } = await login(u);
    const found = await sessions.findByTokenHash(hash);
    expect(found).toEqual(session);
    expect(Object.keys(found ?? {}).toSorted()).toEqual([
      "createdAt",
      "expiresAt",
      "id",
      "lastSeenAt",
      "revokedAt",
      "userId",
    ]);
    expect(JSON.stringify(found)).not.toContain(hash);
    expect(isSessionActive(session, now)).toBe(true);
  });

  it("stores only the SHA-256 bytes, never anything token-shaped", async () => {
    const { user: u } = await user();
    const { hash } = await login(u);
    const { rows } = await fx.owner.query<{ hex: string; len: number }>(
      "select encode(token_hash, 'hex') as hex, octet_length(token_hash) as len from sessions where user_id = $1",
      [u.id],
    );
    expect(rows).toEqual([{ hex: hash, len: 32 }]);
  });

  it("finds nothing for an unknown hash", async () => {
    expect(await sessions.findByTokenHash(tokenHash())).toBeNull();
  });

  it("touch and revoke act on the presented session only", async () => {
    const { user: u } = await user();
    const [one, two] = [await login(u), await login(u)];
    const later = new Date(now.getTime() + 600_000);
    await sessions.touch(one.hash, later);
    expect((await sessions.findByTokenHash(one.hash))?.lastSeenAt).toEqual(later);
    expect((await sessions.findByTokenHash(two.hash))?.lastSeenAt).toEqual(now);

    await sessions.revoke(one.hash, later);
    const revoked = await sessions.findByTokenHash(one.hash);
    expect(revoked?.revokedAt).toEqual(later);
    expect(revoked && isSessionActive(revoked, later)).toBe(false);
    expect((await sessions.findByTokenHash(two.hash))?.revokedAt).toBeNull();
    // Revoking again keeps the first revocation time; touching a revoked session does nothing.
    await sessions.revoke(one.hash, new Date(later.getTime() + 1000));
    await sessions.touch(one.hash, new Date(later.getTime() + 1000));
    const again = await sessions.findByTokenHash(one.hash);
    expect(again?.revokedAt).toEqual(later);
    expect(again?.lastSeenAt).toEqual(later);
  });

  it("revokeAllForUser revokes every session of that user and no one else's", async () => {
    const [a, b] = [await user(), await user()];
    const [a1, a2, b1] = [await login(a.user), await login(a.user), await login(b.user)];
    await sessions.revokeAllForUser(a.user.id, now);
    expect((await sessions.findByTokenHash(a1.hash))?.revokedAt).toEqual(now);
    expect((await sessions.findByTokenHash(a2.hash))?.revokedAt).toEqual(now);
    expect((await sessions.findByTokenHash(b1.hash))?.revokedAt).toBeNull();
  });

  it("deleteExpiredForUser removes dead sessions of that user only", async () => {
    const [a, b] = [await user(), await user()];
    const live = await login(a.user);
    const revoked = await login(a.user);
    await sessions.revoke(revoked.hash, now);
    const expired = await fx.seedSession(a.user.id, { expiresAt: new Date(now.getTime() - 1000) });
    const others = await fx.seedSession(b.user.id, { revokedAt: now });

    expect(await sessions.deleteExpiredForUser(a.user.id, now)).toBe(2);
    expect(await sessions.findByTokenHash(live.hash)).not.toBeNull();
    expect(await sessions.findByTokenHash(revoked.hash)).toBeNull();
    expect(await sessions.findByTokenHash(parseSessionTokenHash(expired.hash))).toBeNull();
    expect(await sessions.findByTokenHash(parseSessionTokenHash(others.hash))).not.toBeNull();
  });

  it("rejects a duplicate token hash", async () => {
    const [a, b] = [await user(), await user()];
    const { hash } = await login(a.user);
    await expect(login(b.user, hash)).rejects.toThrow();
  });
});
