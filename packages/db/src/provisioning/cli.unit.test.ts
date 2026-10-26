import { EnvError } from "@contextvault/config";
import { describe, expect, it } from "vitest";
import { type CliIo, type CliOps, runCli } from "./cli";
import { AccountExists, InputAborted, NotInteractive } from "./errors";

const secret = "correct horse battery";

function setup(overrides: Partial<CliOps> = {}, answers: (string | Error)[] = [secret, secret]) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: unknown[] = [];
  const opened: string[] = [];
  const closed: boolean[] = [];
  const prompts: string[] = [];
  const io: CliIo = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    readSecret: async (p) => {
      prompts.push(p);
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next ?? "";
    },
  };
  const ops: CliOps = {
    provision: async (i) => {
      calls.push(i);
      return {
        email: i.email,
        workspaceName: "Personal workspace",
        workspaceCreated: true,
        resumed: false,
      };
    },
    reset: async (i) => {
      calls.push(i);
      return { email: i.email, revokedSessions: 2 };
    },
    close: async () => {
      closed.push(true);
    },
    ...overrides,
  };
  const run = (argv: string[]) =>
    runCli(argv, io, async (c) => {
      opened.push(c);
      return ops;
    });
  return { run, out, err, calls, opened, closed, prompts };
}

describe("runCli", () => {
  it("creates a user with the prompted password and prints no secret", async () => {
    const s = setup();
    expect(await s.run(["--email", "a@example.com", "--workspace-name", "Lab"])).toBe(0);
    expect(s.opened).toEqual(["create"]);
    expect(s.calls).toEqual([
      { email: "a@example.com", password: secret, confirmation: secret, workspaceName: "Lab" },
    ]);
    expect(s.out).toEqual(['Created a@example.com with workspace "Personal workspace".']);
    expect(JSON.stringify([s.out, s.err, s.prompts])).not.toContain(secret);
    expect(s.closed).toEqual([true]);
  });

  it("resets a password", async () => {
    const s = setup();
    expect(await s.run(["--email", "a@example.com", "--reset-password"])).toBe(0);
    expect(s.opened).toEqual(["reset"]);
    expect(s.out).toEqual(["Password reset for a@example.com; revoked 2 session(s)."]);
  });

  it.each([
    [[]],
    [["--reset-password"]],
    [["--email", "a@example.com", "extra"]],
    [["--email", "a@example.com", "--password", secret]],
    [["--email", "a@example.com", `--password=${secret}`]],
    [["--email", "a@example.com", "--reset-password", "--workspace-name", "x"]],
  ])("rejects arguments %j with usage only, opening nothing and echoing nothing", async (argv) => {
    const s = setup();
    expect(await s.run(argv)).toBe(2);
    expect(s.opened).toEqual([]);
    expect(s.prompts).toEqual([]);
    expect(s.err.join("\n")).toContain("never accepted as an argument");
    expect(s.err.join("\n")).not.toContain(secret);
  });

  it.each([
    [new NotInteractive(), "interactive terminal"],
    [new InputAborted(), "Aborted"],
  ])("stops on a failed prompt (%s) before any write", async (failure, text) => {
    const s = setup({}, [failure]);
    expect(await s.run(["--email", "a@example.com"])).toBe(1);
    expect(s.calls).toEqual([]);
    expect(s.err.join("\n")).toContain(text);
    expect(s.closed).toEqual([true]);
  });

  it("reports a domain error by its fixed message", async () => {
    const s = setup({
      provision: async () => {
        throw new AccountExists();
      },
    });
    expect(await s.run(["--email", "a@example.com"])).toBe(1);
    expect(s.err).toEqual(["Error: An account with that email already exists"]);
  });

  it("keeps connection details and driver text out of unknown errors", async () => {
    const leak = "postgres://contextvault:hunter2@db.internal:5432/x password hash $argon2id$";
    const s = setup({
      provision: async () => {
        throw new Error(leak);
      },
    });
    expect(await s.run(["--email", "a@example.com"])).toBe(1);
    expect(s.err).toEqual(["Error: Unexpected failure"]);
  });

  it("maps a database error to its SQLSTATE only", async () => {
    const s = setup({
      provision: async () => {
        throw Object.assign(new Error("password authentication failed for hunter2"), {
          code: "28P01",
        });
      },
    });
    await s.run(["--email", "a@example.com"]);
    expect(s.err).toEqual(["Error: Database error (SQLSTATE 28P01)"]);
  });

  it("surfaces an environment error naming variables, and still closes", async () => {
    const s = setup();
    const code = await runCli(
      ["--email", "a@example.com"],
      { out: () => undefined, err: (l) => s.err.push(l), readSecret: async () => secret },
      async () => {
        throw new EnvError("Invalid environment variables:\n- DATABASE_URL: Invalid URL");
      },
    );
    expect(code).toBe(1);
    expect(s.err[0]).toContain("DATABASE_URL");
  });
});
