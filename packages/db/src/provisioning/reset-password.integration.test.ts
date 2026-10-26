import { randomUUID } from "node:crypto";
import {
  parseEmail,
  parsePassword,
  parseSessionTokenHash,
  parseUserId,
} from "@contextvault/domain";
import { afterAll, describe, expect, it } from "vitest";
import { AccountNotFound } from "./errors";
import { provisionAccount } from "./provision-account";
import { resetPassword } from "./reset-password";
import { password, provisioningHarness } from "./test-harness";

const h = provisioningHarness();
afterAll(() => h.close());

const next = "an entirely different phrase";
const reset = (email: string, now?: () => Date) =>
  resetPassword(
    { reset: h.reset, hasher: h.hasher, ...(now ? { now } : {}) },
    {
      email,
      password: next,
      confirmation: next,
    },
  );

async function account() {
  const email = h.newEmail();
  await provisionAccount(h.deps(), { email, password, confirmation: password });
  const id = await h.idOf(email);
  return { email, id, a: await h.fx.seedSession(id), b: await h.fx.seedSession(id) };
}

const revokedAt = async (sessionId: string) =>
  (await h.fx.owner.query("select revoked_at from sessions where id = $1", [sessionId])).rows[0]
    ?.revoked_at;
const passwordWorks = async (email: string, plain: string) => {
  const stored = await h.fx.persistence.auth.credentials.findByEmail(parseEmail(email));
  return stored !== null && (await h.hasher.verify(parsePassword(plain), stored.passwordHash));
};

describe("password reset against PostgreSQL", () => {
  it("replaces the hash and revokes every session of that user only", async () => {
    const target = await account();
    const other = await account();
    const done = await reset(target.email);

    expect(done.revokedSessions).toBe(2);
    expect(await passwordWorks(target.email, next)).toBe(true);
    expect(await passwordWorks(target.email, password)).toBe(false);
    expect(await revokedAt(target.a.id)).not.toBeNull();
    expect(await revokedAt(target.b.id)).not.toBeNull();
    const dead = await h.fx.persistence.auth.sessions.findByTokenHash(
      parseSessionTokenHash(target.a.hash),
    );
    expect(dead?.revokedAt).not.toBeNull();
    // Another user's password and sessions are untouched.
    expect(await passwordWorks(other.email, password)).toBe(true);
    expect(await revokedAt(other.a.id)).toBeNull();
  });

  it("keeps already-revoked sessions as they were and reports only newly revoked ones", async () => {
    const t = await account();
    await reset(t.email);
    expect((await reset(t.email)).revokedSessions).toBe(0);
  });

  it("is atomic: a failure after the hash update keeps the old password and live sessions", async () => {
    const t = await account();
    // Serialises fine for the credential update, then throws on the session revocation.
    class FlakyDate extends Date {
      calls = 0;
      override toISOString(): string {
        this.calls += 1;
        if (this.calls > 1) throw new Error("simulated failure during revocation");
        return super.toISOString();
      }
    }
    await expect(reset(t.email, () => new FlakyDate())).rejects.toThrow("simulated failure");
    expect(await passwordWorks(t.email, password)).toBe(true);
    expect(await passwordWorks(t.email, next)).toBe(false);
    expect(await revokedAt(t.a.id)).toBeNull();
    expect(await revokedAt(t.b.id)).toBeNull();
  });

  it("refuses an unknown email and an account whose creation never finished", async () => {
    await expect(reset(h.newEmail())).rejects.toBeInstanceOf(AccountNotFound);
    const half = h.newEmail();
    await h.deps().owner.claimUser(parseUserId(randomUUID()), half);
    await expect(reset(half)).rejects.toBeInstanceOf(AccountNotFound);
  });
});
