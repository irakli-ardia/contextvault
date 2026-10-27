import { parsePassword } from "@contextvault/domain";
import { afterAll, describe, expect, it } from "vitest";
import { sqlState } from "../tenant-fixture";
import { AccountExists } from "./errors";
import { provisionAccount } from "./provision-account";
import { password, provisioningHarness } from "./test-harness";

const h = await provisioningHarness();
afterAll(() => h.close());

const input = (email: string) => ({ email, password, confirmation: password });

describe("account provisioning against PostgreSQL", () => {
  it("creates a loginable user with a personal workspace and owner membership", async () => {
    const email = h.newEmail();
    await provisionAccount(h.deps(), { ...input(email), workspaceName: "Lab" });

    const stored = await h.fx.persistence.auth.credentials.findByEmail(email);
    if (stored === null) throw new Error("credential missing");
    expect(await h.hasher.verify(parsePassword(password), stored.passwordHash)).toBe(true);
    const workspaces = await h.fx.persistence.unitOfWork.run({ userId: stored.user.id }, (r) =>
      r.workspaces.listForUser(stored.user.id),
    );
    expect(workspaces.map((w) => [w.name, w.role])).toEqual([["Lab", "owner"]]);
  });

  it("refuses a duplicate email, case-insensitively, and creates nothing more", async () => {
    const email = h.newEmail();
    await provisionAccount(h.deps(), input(email));
    await expect(
      provisionAccount(h.deps(), input(` ${email.toUpperCase()} `)),
    ).rejects.toBeInstanceOf(AccountExists);
    expect(await h.accountOf(email)).toMatchObject({
      credentials: 1,
      workspaces: 1,
      memberships: 1,
    });
  });

  it("leaves no loginable account when the workspace step fails, and a rerun completes it", async () => {
    const email = h.newEmail();
    const broken = h.deps({
      ensureWorkspace: () => () =>
        Promise.reject(new Error("simulated crash before the workspace commit")),
    });
    await expect(provisionAccount(broken, input(email))).rejects.toThrow("simulated crash");
    expect(await h.accountOf(email)).toMatchObject({ exists: true, credentials: 0, workspaces: 0 });
    expect(await h.fx.persistence.auth.credentials.findByEmail(email)).toBeNull();

    const result = await provisionAccount(h.deps(), input(email));
    expect(result.resumed).toBe(true);
    expect(await h.accountOf(email)).toMatchObject({
      credentials: 1,
      workspaces: 1,
      memberships: 1,
    });
  });

  it("does not add a second workspace when only the credential step failed", async () => {
    const email = h.newEmail();
    const broken = h.deps({
      owner: (real) => ({
        ...real,
        insertCredential: () => Promise.reject(new Error("simulated crash before the credential")),
      }),
    });
    await expect(provisionAccount(broken, input(email))).rejects.toThrow("simulated crash");
    expect(await h.accountOf(email)).toMatchObject({
      credentials: 0,
      workspaces: 1,
      memberships: 1,
    });

    await provisionAccount(h.deps(), input(email));
    expect(await h.accountOf(email)).toMatchObject({
      credentials: 1,
      workspaces: 1,
      memberships: 1,
    });
  });

  it("lets exactly one of two concurrent runs finish", async () => {
    const email = h.newEmail();
    const results = await Promise.allSettled([
      provisionAccount(h.deps(), input(email)),
      provisionAccount(h.deps(), input(email)),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(AccountExists);
    expect(await h.accountOf(email)).toMatchObject({ credentials: 1, workspaces: 1 });
  });

  it("rejects bad input before any row is written", async () => {
    const email = h.newEmail();
    await expect(
      provisionAccount(h.deps(), { ...input(email), password: "short", confirmation: "short" }),
    ).rejects.toThrow();
    await expect(
      provisionAccount(h.deps(), { ...input(email), confirmation: "something else entirely" }),
    ).rejects.toThrow();
    await expect(provisionAccount(h.deps(), input("not-an-email"))).rejects.toThrow();
    expect((await h.accountOf(email)).exists).toBe(false);
  });
});

describe("database permission boundaries", () => {
  it("the application role cannot create users or credentials, so provisioning needs the owner", async () => {
    const id = crypto.randomUUID();
    expect(
      await sqlState(
        h.fx.queryAs({ userId: id }, "insert into users (id, email) values ($1, $2)", [
          id,
          `${id}@test.invalid`,
        ]),
      ),
    ).toBe("42501");
    expect(
      await sqlState(
        h.fx.queryAs(
          { userId: id },
          "insert into user_credentials (user_id, password_hash) values ($1, 'x')",
          [id],
        ),
      ),
    ).toBe("42501");
  });

  it("a provisioned credential is invisible to its own user context and to no context", async () => {
    const email = h.newEmail();
    await provisionAccount(h.deps(), input(email));
    const { id } = await h.accountOf(email);
    expect(await h.fx.queryAs({ userId: id }, "select 1 from user_credentials")).toEqual([]);
    expect(await h.fx.queryAs(null, "select 1 from user_credentials")).toEqual([]);
  });
});
