import type { Email, PasswordHasher, UserId } from "@contextvault/domain";
import { describe, expect, it } from "vitest";
import { AccountExists } from "./errors";
import type { OwnerAccounts } from "./owner-accounts";
import { type ProvisionDeps, provisionAccount } from "./provision-account";

const password = "correct horse battery";
const ids = ["0b1c9d3e-5a7f-4c2d-8e1f-3a4b5c6d7e01", "0b1c9d3e-5a7f-4c2d-8e1f-3a4b5c6d7e02"];

function harness() {
  const log: string[] = [];
  const users = new Map<string, UserId>();
  const credentials = new Set<string>();
  const workspaces: { name: string; owner: string }[] = [];
  const fail = { workspace: false, credential: false };
  let next = 0;

  const owner: OwnerAccounts = {
    async claimUser(id: UserId, email: Email) {
      log.push("claim");
      const existing = users.get(email);
      if (existing === undefined) {
        users.set(email, id);
        return { id, created: true, hasCredential: false };
      }
      return { id: existing, created: false, hasCredential: credentials.has(existing) };
    },
    async insertCredential(userId, hash) {
      log.push("credential");
      if (fail.credential) throw new Error("credential write failed");
      if (credentials.has(userId)) throw new AccountExists();
      expect(hash).toBe(`hash:${password}`);
      credentials.add(userId);
    },
  };
  const hasher: PasswordHasher = {
    hash: async (p) => {
      log.push("hash");
      return `hash:${p}`;
    },
    verify: async () => true,
    needsRehash: () => false,
  };
  const deps: ProvisionDeps = {
    owner,
    hasher,
    newId: () => ids[next++ % 2] ?? "",
    ensureWorkspace: async (userId, workspace) => {
      if (fail.workspace) throw new Error("workspace write failed");
      const existing = workspaces.find((w) => w.owner === userId);
      if (existing !== undefined) return { name: existing.name, created: false };
      log.push("workspace");
      workspaces.push({ name: workspace.name, owner: userId });
      return { name: workspace.name, created: true };
    },
  };
  return { deps, log, users, credentials, workspaces, fail };
}

const input = { email: "  Ada@Example.COM ", password, confirmation: password };

describe("provisionAccount", () => {
  it("hashes first, then user, workspace, credential — credential last", async () => {
    const h = harness();
    const result = await provisionAccount(h.deps, input);
    expect(result).toEqual({
      email: "ada@example.com",
      workspaceName: "Personal workspace",
      workspaceCreated: true,
      resumed: false,
    });
    expect(h.log).toEqual(["hash", "claim", "workspace", "credential"]);
    expect(h.workspaces).toEqual([{ name: "Personal workspace", owner: ids[0] }]);
  });

  it("uses the requested workspace name, trimmed", async () => {
    const h = harness();
    await provisionAccount(h.deps, { ...input, workspaceName: "  Research  " });
    expect(h.workspaces[0]?.name).toBe("Research");
  });

  it.each([
    ["invalid email", { ...input, email: "not-an-email" }],
    ["weak password", { ...input, password: "short", confirmation: "short" }],
    ["empty password", { ...input, password: "", confirmation: "" }],
    ["mismatched confirmation", { ...input, confirmation: `${password}!` }],
    ["empty workspace name", { ...input, workspaceName: "   " }],
    ["overlong workspace name", { ...input, workspaceName: "x".repeat(121) }],
  ])("writes nothing for %s", async (_name, bad) => {
    const h = harness();
    await expect(provisionAccount(h.deps, bad)).rejects.toThrow();
    expect(h.log).toEqual([]);
  });

  it("refuses a duplicate and creates no workspace", async () => {
    const h = harness();
    await provisionAccount(h.deps, input);
    h.log.length = 0;
    await expect(provisionAccount(h.deps, input)).rejects.toBeInstanceOf(AccountExists);
    expect(h.log).not.toContain("workspace");
    expect(h.log).not.toContain("credential");
    expect(h.workspaces).toHaveLength(1);
  });

  it("recovers from a failed workspace step: no credential, then a rerun finishes", async () => {
    const h = harness();
    h.fail.workspace = true;
    await expect(provisionAccount(h.deps, input)).rejects.toThrow("workspace write failed");
    expect(h.credentials.size).toBe(0);
    h.fail.workspace = false;
    const result = await provisionAccount(h.deps, input);
    expect(result.resumed).toBe(true);
    expect(h.workspaces).toHaveLength(1);
    expect(h.credentials.size).toBe(1);
  });

  it("reports the workspace that exists, not the requested name, when resuming", async () => {
    const h = harness();
    h.fail.credential = true;
    await expect(provisionAccount(h.deps, { ...input, workspaceName: "First" })).rejects.toThrow();
    h.fail.credential = false;
    const result = await provisionAccount(h.deps, { ...input, workspaceName: "Second" });
    expect(result).toMatchObject({
      workspaceName: "First",
      workspaceCreated: false,
      resumed: true,
    });
    expect(h.workspaces.map((w) => w.name)).toEqual(["First"]);
  });

  it("recovers from a failed credential step without a second workspace", async () => {
    const h = harness();
    h.fail.credential = true;
    await expect(provisionAccount(h.deps, input)).rejects.toThrow("credential write failed");
    h.fail.credential = false;
    const result = await provisionAccount(h.deps, input);
    expect(result.resumed).toBe(true);
    expect(h.workspaces).toHaveLength(1);
    expect(h.credentials.size).toBe(1);
  });

  it("never puts the password in a domain error", async () => {
    const h = harness();
    const weak = await provisionAccount(h.deps, {
      ...input,
      password: "short",
      confirmation: "short",
    }).catch((e: unknown) => e);
    expect(String(weak)).not.toContain("short");
    const mismatch = await provisionAccount(h.deps, {
      ...input,
      confirmation: "other-secret-value",
    }).catch((e: unknown) => e);
    expect(String(mismatch)).not.toContain(password);
    expect(String(mismatch)).not.toContain("other-secret-value");
  });
});
