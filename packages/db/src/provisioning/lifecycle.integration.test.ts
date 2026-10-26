import { randomUUID } from "node:crypto";
import { parseUserId, parseWorkspaceId } from "@contextvault/domain";
import { afterAll, describe, expect, it } from "vitest";
import { workspaceLockName } from "./ensure-workspace";
import { AccountExists } from "./errors";
import { provisionAccount } from "./provision-account";
import { password, provisioningHarness } from "./test-harness";

const h = provisioningHarness();
afterAll(() => h.close());

const input = (email: string) => ({ email, password, confirmation: password });
const workspace = (name = "W") => ({ id: parseWorkspaceId(randomUUID()), name });

async function userRow() {
  const email = h.newEmail();
  const claimed = await h.deps().owner.claimUser(parseUserId(randomUUID()), email);
  return { email, id: claimed.id };
}

describe("concurrent provisioning", () => {
  it("many concurrent workspace bootstraps for one user create exactly one workspace", async () => {
    const { email, id } = await userRow();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => h.deps().ensureWorkspace(id, workspace())),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect((await h.accountOf(email)).workspaces).toBe(1);
  });

  it("a bootstrap blocks on the per-user lock until it is released", async () => {
    const { email, id } = await userRow();
    const holder = await h.fx.owner.connect();
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
        workspaceLockName(id),
      ]);
      const pending = h.deps().ensureWorkspace(id, workspace("Late"));
      const state = await Promise.race([
        pending.then(() => "finished"),
        new Promise((resolve) => setTimeout(resolve, 200, "blocked")),
      ]);
      expect(state).toBe("blocked");
      await holder.query("commit");
      expect(await pending).toMatchObject({ name: "Late", created: true });
      expect(await h.deps().ensureWorkspace(id, workspace("Later"))).toEqual({
        name: "Late",
        created: false,
      });
    } finally {
      holder.release();
    }
    expect((await h.accountOf(email)).workspaces).toBe(1);
  });

  it("concurrent full runs leave one user, one workspace, one credential", async () => {
    const email = h.newEmail();
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => provisionAccount(h.deps(), input(email))),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) {
      if (r.status === "rejected") expect(r.reason).toBeInstanceOf(AccountExists);
    }
    expect(await h.accountOf(email)).toMatchObject({
      credentials: 1,
      workspaces: 1,
      memberships: 1,
    });
  });
});

describe("account lifecycle safety", () => {
  it("running create again never changes a completed account", async () => {
    const email = h.newEmail();
    await provisionAccount(h.deps(), { ...input(email), workspaceName: "Original" });
    const before = await h.fx.persistence.auth.credentials.findByEmail(email);
    const session = await h.fx.seedSession(await h.idOf(email));

    const other = "a different passphrase";
    await expect(
      provisionAccount(h.deps(), {
        email,
        password: other,
        confirmation: other,
        workspaceName: "Hijacked",
      }),
    ).rejects.toBeInstanceOf(AccountExists);

    const after = await h.fx.persistence.auth.credentials.findByEmail(email);
    expect(after?.passwordHash).toBe(before?.passwordHash);
    await expect(h.attemptLogin(email, other)).rejects.toThrow("Invalid email or password");
    expect(await h.attemptLogin(email, password)).toMatchObject({ user: { email } });
    const names = await h.fx.owner.query("select name from workspaces where created_by = $1", [
      await h.idOf(email),
    ]);
    expect(names.rows).toEqual([{ name: "Original" }]);
    const revoked = await h.fx.owner.query("select revoked_at from sessions where id = $1", [
      session.id,
    ]);
    expect(revoked.rows[0]?.revoked_at).toBeNull();
  });

  it("a partially created user cannot log in until the account is completed", async () => {
    const email = h.newEmail();
    const crash = h.deps({
      owner: (real) => ({ ...real, insertCredential: () => Promise.reject(new Error("killed")) }),
    });
    await expect(provisionAccount(crash, input(email))).rejects.toThrow("killed");
    await expect(h.attemptLogin(email, password)).rejects.toThrow("Invalid email or password");

    await provisionAccount(h.deps(), input(email));
    expect(await h.attemptLogin(email, password)).toMatchObject({ user: { email } });
  });
});
