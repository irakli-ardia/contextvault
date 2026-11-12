import type { DocumentResponse } from "@contextvault/contracts";
import { queryOptions } from "@tanstack/react-query";
import { listDocuments } from "./api";

export const documentsKey = (workspaceId: string) => ["documents", workspaceId] as const;

// `uploaded` and `processed` are transient states between worker stages.
const SETTLED = new Set(["ready", "failed"]);
export const isProcessing = (doc: DocumentResponse): boolean => !SETTLED.has(doc.status);

const POLL_MS = 2_000;

// Polls only while something is still moving; an idle library makes no background requests.
export const documentsQueryOptions = (workspaceId: string) =>
  queryOptions({
    queryKey: documentsKey(workspaceId),
    queryFn: ({ signal }) => listDocuments(workspaceId, signal),
    refetchInterval: (query) => (query.state.data?.documents.some(isProcessing) ? POLL_MS : false),
  });
