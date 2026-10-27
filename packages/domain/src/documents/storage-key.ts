import type { DocumentId, DocumentVersionId, WorkspaceId } from "../kernel/ids";
import { StorageError } from "./errors";

export type StorageKey = string & { readonly brand: "StorageKey" };

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const keyPattern = new RegExp(`^ws/${uuid}/doc/${uuid}/v/${uuid}$`);

const isStorageKey = (value: string): value is StorageKey => keyPattern.test(value);

// Only server-issued ids appear: no filename, extension, email, or client value.
export function documentObjectKey(
  workspaceId: WorkspaceId,
  documentId: DocumentId,
  versionId: DocumentVersionId,
): StorageKey {
  return parseStorageKey(`ws/${workspaceId}/doc/${documentId}/v/${versionId}`);
}

// Adapters call this on every key, so a forged string cannot reach the provider.
export function parseStorageKey(value: string): StorageKey {
  if (!isStorageKey(value)) throw new StorageError("storage.invalid_key", false);
  return value;
}
