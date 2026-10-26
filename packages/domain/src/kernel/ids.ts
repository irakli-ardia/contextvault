import { DomainError } from "./errors";

export type UserId = string & { readonly brand: "UserId" };
export type WorkspaceId = string & { readonly brand: "WorkspaceId" };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const isUuid = (value: string): boolean => uuidPattern.test(value);
const isUserId = (value: string): value is UserId => isUuid(value);
const isWorkspaceId = (value: string): value is WorkspaceId => isUuid(value);

export function parseUserId(value: string): UserId {
  if (!isUserId(value)) throw new DomainError("id.invalid", "Invalid user id");
  return value;
}

export function parseWorkspaceId(value: string): WorkspaceId {
  if (!isWorkspaceId(value)) throw new DomainError("id.invalid", "Invalid workspace id");
  return value;
}

export type SessionId = string & { readonly brand: "SessionId" };

const isSessionId = (value: string): value is SessionId => isUuid(value);

export function parseSessionId(value: string): SessionId {
  if (!isSessionId(value)) throw new DomainError("id.invalid", "Invalid session id");
  return value;
}
