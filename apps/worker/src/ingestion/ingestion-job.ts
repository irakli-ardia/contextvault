import {
  type DocumentVersionId,
  parseDocumentVersionId,
  parseWorkspaceId,
  type WorkspaceId,
} from "@contextvault/domain";

export interface IngestionJobPayload {
  readonly workspaceId: WorkspaceId;
  readonly versionId: DocumentVersionId;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Exactly the two ids the producer writes; anything else is not ours to act on. `null` for any
// malformed payload, so no part of it reaches a log or an error message.
export function parseIngestionPayload(data: unknown): IngestionJobPayload | null {
  if (!isRecord(data)) return null;
  const { workspaceId, versionId, ...rest } = data;
  if (Object.keys(rest).length > 0) return null;
  if (typeof workspaceId !== "string" || typeof versionId !== "string") return null;
  try {
    return {
      workspaceId: parseWorkspaceId(workspaceId),
      versionId: parseDocumentVersionId(versionId),
    };
  } catch {
    return null;
  }
}
