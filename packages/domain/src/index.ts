export { StorageError, type StorageErrorCode } from "./documents/errors";
export type { DocumentStore, StoredObject } from "./documents/ports";
export { documentObjectKey, parseStorageKey, type StorageKey } from "./documents/storage-key";
export { type Email, parseEmail } from "./identity/email";
export { HashingBusy, InvalidCredentials, Unauthenticated } from "./identity/errors";
export { type LoginDeps, type LoginInput, login } from "./identity/login";
export { getProfile, type Profile } from "./identity/me";
export { type Password, parsePassword, passwordLength } from "./identity/password";
export type {
  CredentialStore,
  PasswordHasher,
  SessionStore,
  StoredCredential,
  User,
  UserRepository,
} from "./identity/ports";
export {
  type Identity,
  logout,
  resolveSession,
  type SessionDeps,
} from "./identity/resolve-session";
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
  type DocumentId,
  type DocumentVersionId,
  parseDocumentId,
  parseDocumentVersionId,
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
export { readWorkspace } from "./workspaces/read-workspace";
export { resolveActor } from "./workspaces/resolve-actor";
export {
  isRole,
  type Membership,
  type Role,
  roles,
  type Workspace,
  type WorkspaceWithRole,
} from "./workspaces/workspace";
