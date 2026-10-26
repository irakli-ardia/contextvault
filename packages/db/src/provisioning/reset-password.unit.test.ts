import type { PasswordHasher } from "@contextvault/domain";
import { describe, expect, it } from "vitest";
import { AccountNotFound, PasswordMismatch } from "./errors";
import { resetPassword } from "./reset-password";

const password = "correct horse battery";
const now = new Date("2026-01-01T00:00:00Z");

function deps(result: { revokedSessions: number } | null) {
  const calls: unknown[][] = [];
  const hasher: PasswordHasher = {
    hash: async (p) => `hash:${p}`,
    verify: async () => true,
    needsRehash: () => false,
  };
  return {
    calls,
    deps: {
      hasher,
      now: () => now,
      reset: async (...args: unknown[]) => {
        calls.push(args);
        return result;
      },
    },
  };
}

describe("resetPassword", () => {
  it("hashes the normalized email's new password and reports the revoked sessions", async () => {
    const d = deps({ revokedSessions: 3 });
    const done = await resetPassword(d.deps, {
      email: " Ada@Example.com",
      password,
      confirmation: password,
    });
    expect(done).toEqual({ email: "ada@example.com", revokedSessions: 3 });
    expect(d.calls).toEqual([["ada@example.com", `hash:${password}`, now]]);
  });

  it("fails for an unknown account", async () => {
    const d = deps(null);
    await expect(
      resetPassword(d.deps, { email: "x@example.com", password, confirmation: password }),
    ).rejects.toBeInstanceOf(AccountNotFound);
  });

  it.each([
    [{ email: "bad", password, confirmation: password }],
    [{ email: "a@example.com", password: "short", confirmation: "short" }],
    [{ email: "a@example.com", password, confirmation: "different password" }],
  ])("touches nothing for invalid input %#", async (input) => {
    const d = deps({ revokedSessions: 0 });
    await expect(resetPassword(d.deps, input)).rejects.toThrow();
    expect(d.calls).toEqual([]);
  });

  it("reports a mismatch without echoing either password", async () => {
    const d = deps({ revokedSessions: 0 });
    const error = await resetPassword(d.deps, {
      email: "a@example.com",
      password,
      confirmation: "different password",
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PasswordMismatch);
    expect(String(error)).not.toContain("different password");
  });
});
