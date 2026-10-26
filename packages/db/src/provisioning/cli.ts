import { parseArgs } from "node:util";
import { EnvError } from "@contextvault/config";
import { DomainError } from "@contextvault/domain";
import { postgresErrorCode } from "../repositories/workspaces/postgres-error";
import type { ProvisionInput, ProvisionResult } from "./provision-account";

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  /** Interactive and unechoed, or it throws; never a pipe or an environment variable. */
  readSecret(prompt: string): Promise<string>;
}

export interface CliOps {
  provision(input: ProvisionInput): Promise<ProvisionResult>;
  reset(input: {
    email: string;
    password: string;
    confirmation: string;
  }): Promise<{ email: string; revokedSessions: number }>;
  close(): Promise<void>;
}

const usage = `Usage:
  pnpm run user:create -- --email <email> [--workspace-name <name>]
  pnpm run user:create -- --email <email> --reset-password
The password is always prompted for on the terminal; it is never accepted as an argument.`;

// Messages are fixed text from our own errors; an unknown error is reduced to a class of failure
// so a driver message (which may carry connection details) never reaches the terminal.
function describe(error: unknown): string {
  if (error instanceof DomainError || error instanceof EnvError) return error.message;
  const code = postgresErrorCode(error);
  return code === undefined ? "Unexpected failure" : `Database error (SQLSTATE ${code})`;
}

function parse(argv: readonly string[]) {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        email: { type: "string" },
        "workspace-name": { type: "string" },
        "reset-password": { type: "boolean" },
      },
    });
    const valid = positionals.length === 0 && values.email !== undefined;
    const conflict = values["reset-password"] === true && values["workspace-name"] !== undefined;
    return valid && !conflict ? values : null;
  } catch {
    return null;
  }
}

export async function runCli(
  argv: readonly string[],
  io: CliIo,
  open: (command: "create" | "reset") => Promise<CliOps>,
): Promise<number> {
  const args = parse(argv);
  if (args?.email === undefined) {
    io.err(usage);
    return 2;
  }
  const reset = args["reset-password"] === true;
  let ops: CliOps | undefined;
  try {
    ops = await open(reset ? "reset" : "create");
    const password = await io.readSecret("New password: ");
    const confirmation = await io.readSecret("Repeat password: ");
    if (reset) {
      const done = await ops.reset({ email: args.email, password, confirmation });
      io.out(`Password reset for ${done.email}; revoked ${done.revokedSessions} session(s).`);
    } else {
      const done = await ops.provision({
        email: args.email,
        password,
        confirmation,
        workspaceName: args["workspace-name"],
      });
      const requested = args["workspace-name"]?.trim();
      const kept = done.workspaceCreated
        ? `with workspace "${done.workspaceName}"`
        : `and kept its existing workspace "${done.workspaceName}"`;
      const ignored =
        !done.workspaceCreated && requested !== undefined && requested !== done.workspaceName
          ? ` (--workspace-name "${requested}" was not applied)`
          : "";
      const note = done.resumed ? " (completed an interrupted earlier run)" : "";
      io.out(`Created ${done.email} ${kept}${ignored}${note}.`);
    }
    return 0;
  } catch (error) {
    io.err(`Error: ${describe(error)}`);
    return 1;
  } finally {
    await ops?.close().catch(() => undefined);
  }
}
