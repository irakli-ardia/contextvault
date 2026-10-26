export { type Email, parseEmail } from "./identity/email";
export { HashingBusy } from "./identity/errors";
export { type Password, parsePassword, passwordLength } from "./identity/password";
export type {
  CredentialStore,
  PasswordHasher,
  SessionStore,
  StoredCredential,
  User,
} from "./identity/ports";
export {
  isSessionActive,
  needsTouch,
  newSession,
  type Session,
  sessionLifetime,
} from "./identity/session";
export {
  parseSessionTokenHash,
  type SessionTokenHash,
  type SessionTokens,
} from "./identity/tokens";
export { DomainError } from "./kernel/errors";
export {
  parseSessionId,
  parseUserId,
  parseWorkspaceId,
  type SessionId,
  type UserId,
  type WorkspaceId,
} from "./kernel/ids";
export type { TenantContext, UnitOfWork } from "./kernel/unit-of-work";
export { AlreadyMember, UnknownUser, WorkspaceAccessDenied } from "./workspaces/errors";
export {
  type Action,
  type Actor,
  actions,
  assertCan,
  can,
  PermissionDenied,
} from "./workspaces/permissions";
export type { WorkspaceRepository } from "./workspaces/ports";
export { isRole, type Membership, type Role, roles, type Workspace } from "./workspaces/workspace";
