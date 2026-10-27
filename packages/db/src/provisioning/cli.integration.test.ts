import { loadDatabaseEnv, loadMigrationEnv } from "@contextvault/config";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../client";
import { PrivilegeCheckFailed } from "../privilege-check";
import { type CliIo, runCli } from "./cli";
import { openOps } from "./open-ops";
import { provisionAccount } from "./provision-account";
import { resetPassword } from "./reset-password";
import { password, provisioningHarness } from "./test-harness";

const h = await provisioningHarness();
afterAll(() => h.close());

function capture(answers: string[]) {
  const lines: string[] = [];
  const io: CliIo = {
    out: (l) => lines.push(l),
    err: (l) => lines.push(l),
    readSecret: async () => answers.shift() ?? "",
  };
  return { io, lines };
}
const ops = () => ({
  provision: (i: Parameters<typeof provisionAccount>[1]) => provisionAccount(h.deps(), i),
  reset: (i: Parameters<typeof resetPassword>[1]) =>
    resetPassword({ reset: h.reset, hasher: h.hasher }, i),
  close: async () => undefined,
});

describe("user:create end to end (real database, injected terminal)", () => {
  it("creates, refuses a repeat, resets, and prints no secret, hash, or session token", async () => {
    const email = h.newEmail();
    const session = await (async () => {
      const first = capture([password, password]);
      expect(await runCli(["--email", email], first.io, async () => ops())).toBe(0);
      return { first, session: await h.fx.seedSession(await h.idOf(email)) };
    })();

    const repeat = capture([password, password]);
    expect(await runCli(["--email", email], repeat.io, async () => ops())).toBe(1);
    expect(repeat.lines).toEqual(["Error: An account with that email already exists"]);

    const fresh = "a brand new passphrase";
    const resetRun = capture([fresh, fresh]);
    expect(
      await runCli(["--email", email, "--reset-password"], resetRun.io, async () => ops()),
    ).toBe(0);

    const stored = await h.fx.persistence.auth.credentials.findByEmail(email);
    const everything = [session.first.lines, repeat.lines, resetRun.lines].flat().join("\n");
    for (const secret of [password, fresh, stored?.passwordHash ?? "?", session.session.hash]) {
      expect(everything).not.toContain(secret);
    }
    expect(everything).not.toContain("$argon2");
    expect(resetRun.lines).toEqual([`Password reset for ${email}; revoked 1 session(s).`]);
  });

  it("a rerun after an interrupted run finishes the account and says so", async () => {
    const email = h.newEmail();
    const crashing = {
      ...ops(),
      provision: (i: Parameters<typeof provisionAccount>[1]) =>
        provisionAccount(
          h.deps({
            owner: (real) => ({
              ...real,
              insertCredential: () => Promise.reject(new Error("killed")),
            }),
          }),
          i,
        ),
    };
    const broken = capture([password, password]);
    expect(await runCli(["--email", email], broken.io, async () => crashing)).toBe(1);
    expect(broken.lines).toEqual(["Error: Unexpected failure"]);

    const again = capture([password, password]);
    expect(await runCli(["--email", email], again.io, async () => ops())).toBe(0);
    expect(again.lines[0]).toContain("completed an interrupted earlier run");
    expect(await h.accountOf(email)).toMatchObject({ credentials: 1, workspaces: 1 });
  });
});

describe("resuming with a different workspace name", () => {
  it("reports the workspace that persists and says the requested name was not applied", async () => {
    const email = h.newEmail();
    const crashing = {
      ...ops(),
      provision: (i: Parameters<typeof provisionAccount>[1]) =>
        provisionAccount(
          h.deps({
            owner: (real) => ({
              ...real,
              insertCredential: () => Promise.reject(new Error("killed")),
            }),
          }),
          i,
        ),
    };
    const first = capture([password, password]);
    await runCli(["--email", email, "--workspace-name", "First"], first.io, async () => crashing);

    const again = capture([password, password]);
    expect(
      await runCli(["--email", email, "--workspace-name", "Second"], again.io, async () => ops()),
    ).toBe(0);
    expect(again.lines).toEqual([
      `Created ${email} and kept its existing workspace "First" (--workspace-name "Second" was not applied) (completed an interrupted earlier run).`,
    ]);
    const rows = await h.fx.fixture.query("select name from workspaces where created_by = $1", [
      await h.idOf(email),
    ]);
    expect(rows.rows).toEqual([{ name: "First" }]);
  });
});

describe("openOps role boundaries", () => {
  it("refuses an owner-role DATABASE_URL before anything is written", async () => {
    vi.stubEnv("DATABASE_URL", loadMigrationEnv().DATABASE_MIGRATION_URL);
    await expect(openOps("reset", h.hasher)).rejects.toBeInstanceOf(PrivilegeCheckFailed);
    await expect(openOps("create", h.hasher)).rejects.toBeInstanceOf(PrivilegeCheckFailed);
  });

  it("a reset needs no owner URL at all, and a create needs it", async () => {
    vi.stubEnv("DATABASE_MIGRATION_URL", undefined);
    const reset = await openOps("reset", h.hasher);
    await reset.close();
    await expect(openOps("create", h.hasher)).rejects.toThrow("DATABASE_MIGRATION_URL");
  });

  it("opens create with the app role on one pool and the owner on another", async () => {
    const created = await openOps("create", h.hasher);
    await created.close();
    const app = createDatabase({ connectionString: loadDatabaseEnv().DATABASE_URL, poolSize: 1 });
    await app.close();
  });
});
