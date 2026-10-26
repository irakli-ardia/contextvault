import { randomUUID } from "node:crypto";
import {
  DomainError,
  type PasswordHasher,
  parseEmail,
  parsePassword,
  parseUserId,
  parseWorkspaceId,
} from "@contextvault/domain";
import type { EnsureWorkspace } from "./ensure-workspace";
import { AccountExists, PasswordMismatch } from "./errors";
import type { OwnerAccounts } from "./owner-accounts";

const defaultWorkspaceName = "Personal workspace";
const workspaceNameMax = 120;

export interface ProvisionDeps {
  readonly owner: OwnerAccounts;
  readonly ensureWorkspace: EnsureWorkspace;
  readonly hasher: PasswordHasher;
  readonly newId?: () => string;
}

export interface ProvisionInput {
  readonly email: string;
  readonly password: string;
  readonly confirmation: string;
  readonly workspaceName?: string | undefined;
}

export interface ProvisionResult {
  readonly email: string;
  /** The workspace that exists, which is not the requested name when one was already there. */
  readonly workspaceName: string;
  readonly workspaceCreated: boolean;
  /** True when an earlier interrupted run had already created the user row. */
  readonly resumed: boolean;
}

function parseWorkspaceName(raw: string | undefined): string {
  const name = (raw ?? defaultWorkspaceName).trim();
  if (name.length < 1 || name.length > workspaceNameMax) {
    throw new DomainError(
      "workspace.name_invalid",
      `Workspace name must be 1-${workspaceNameMax} characters`,
    );
  }
  return name;
}

/**
 * Account creation spans two roles, so it cannot be one transaction. Three committed steps, ordered
 * so that a loginable account (one with a credential) always has its workspace:
 *   1. owner: insert the user (no credential yet, so nobody can log in);
 *   2. app role: create the workspace and owner membership in one transaction (serialised per user),
 *      skipped when the user already has a workspace;
 *   3. owner: insert the credential.
 * An interruption leaves a user without a credential; rerunning with the same email resumes at the
 * first missing step and never duplicates a user, a workspace, or a finished account.
 */
export async function provisionAccount(
  deps: ProvisionDeps,
  input: ProvisionInput,
): Promise<ProvisionResult> {
  const email = parseEmail(input.email);
  if (input.password !== input.confirmation) throw new PasswordMismatch();
  const password = parsePassword(input.password);
  const workspaceName = parseWorkspaceName(input.workspaceName);
  // Slow and memory-hungry: done before any write, never inside a transaction.
  const passwordHash = await deps.hasher.hash(password);

  const newId = deps.newId ?? randomUUID;
  const user = await deps.owner.claimUser(parseUserId(newId()), email);
  if (user.hasCredential) throw new AccountExists();
  const workspace = await deps.ensureWorkspace(user.id, {
    id: parseWorkspaceId(newId()),
    name: workspaceName,
  });
  await deps.owner.insertCredential(user.id, passwordHash);
  return {
    email,
    workspaceName: workspace.name,
    workspaceCreated: workspace.created,
    resumed: !user.created,
  };
}
