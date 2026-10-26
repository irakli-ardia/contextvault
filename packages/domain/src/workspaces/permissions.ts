import { DomainError } from "../kernel/errors";
import type { UserId, WorkspaceId } from "../kernel/ids";
import { WorkspaceAccessDenied } from "./errors";
import type { Role } from "./workspace";

// A row is added only when the endpoint that needs it exists.
export const actions = ["workspace.read"] as const;
export type Action = (typeof actions)[number];

const allowed: Record<Action, readonly Role[]> = {
  "workspace.read": ["owner", "admin", "member"],
};

export const can = (role: Role, action: Action): boolean => allowed[action].includes(role);

// Built from a proven membership; `role` is a per-request snapshot.
export interface Actor {
  readonly userId: UserId;
  readonly workspaceId: WorkspaceId;
  readonly role: Role;
}

export class PermissionDenied extends DomainError {
  constructor(action: Action) {
    super("permission.denied", `Not permitted: ${action}`);
  }
}

/** A resource of another workspace is reported as not found, like a workspace that is absent. */
export function assertCan(actor: Actor, action: Action, resourceWorkspaceId?: WorkspaceId): void {
  if (resourceWorkspaceId !== undefined && resourceWorkspaceId !== actor.workspaceId) {
    throw new WorkspaceAccessDenied();
  }
  if (!can(actor.role, action)) throw new PermissionDenied(action);
}
