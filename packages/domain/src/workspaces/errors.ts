import { DomainError } from "../kernel/errors";

// Also raised when the workspace does not exist, so callers cannot probe for ids.
export class WorkspaceAccessDenied extends DomainError {
  constructor(options?: ErrorOptions) {
    super("workspace.access_denied", "Workspace not found or not permitted", options);
  }
}

export class AlreadyMember extends DomainError {
  constructor(options?: ErrorOptions) {
    super("workspace.already_member", "User is already a member of the workspace", options);
  }
}

export class UnknownUser extends DomainError {
  constructor(options?: ErrorOptions) {
    super("workspace.unknown_user", "User does not exist", options);
  }
}
