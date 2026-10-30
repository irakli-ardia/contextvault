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

export type DocumentId = string & { readonly brand: "DocumentId" };
export type DocumentVersionId = string & { readonly brand: "DocumentVersionId" };

const isDocumentId = (value: string): value is DocumentId => isUuid(value);
const isDocumentVersionId = (value: string): value is DocumentVersionId => isUuid(value);

export function parseDocumentId(value: string): DocumentId {
  if (!isDocumentId(value)) throw new DomainError("id.invalid", "Invalid document id");
  return value;
}

export function parseDocumentVersionId(value: string): DocumentVersionId {
  if (!isDocumentVersionId(value))
    throw new DomainError("id.invalid", "Invalid document version id");
  return value;
}

export type OutboxId = string & { readonly brand: "OutboxId" };

const isOutboxId = (value: string): value is OutboxId => isUuid(value);

export function parseOutboxId(value: string): OutboxId {
  if (!isOutboxId(value)) throw new DomainError("id.invalid", "Invalid outbox id");
  return value;
}
