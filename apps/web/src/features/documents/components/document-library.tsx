"use client";

import type { DocumentResponse } from "@contextvault/contracts";
import { useDocuments } from "../hooks";
import { isProcessing } from "../queries";
import { DocumentRow } from "./document-row";
import { EmptyLibrary, LoadError, RowPlaceholder } from "./library-state";
import { UploadPanel } from "./upload-panel";

function DocumentList({
  documents,
  workspaceId,
}: {
  documents: readonly DocumentResponse[];
  workspaceId: string;
}) {
  if (documents.length === 0) return <EmptyLibrary />;
  return (
    <ul className="mt-4 space-y-3">
      {documents.map((doc) => (
        <DocumentRow key={doc.id} doc={doc} workspaceId={workspaceId} />
      ))}
    </ul>
  );
}

// fallow-ignore-next-line complexity
export function DocumentLibrary({ workspaceId }: { workspaceId: string }) {
  const query = useDocuments(workspaceId);
  const processing = query.data?.documents.filter(isProcessing).length ?? 0;

  return (
    <div className="space-y-8">
      <UploadPanel workspaceId={workspaceId} />
      <section aria-labelledby="library-title">
        <h2 id="library-title" className="text-lg font-semibold tracking-tight">
          Documents
        </h2>
        <p role="status" aria-live="polite" className="mt-1 text-sm text-muted">
          {processing > 0 ? `${processing} processing…` : ""}
        </p>
        {query.isPending ? (
          <ul className="mt-4 space-y-3" aria-busy="true">
            <RowPlaceholder />
            <RowPlaceholder />
          </ul>
        ) : null}
        {query.isError ? (
          <LoadError error={query.error} onRetry={() => void query.refetch()} />
        ) : null}
        {query.isSuccess ? (
          <DocumentList documents={query.data.documents} workspaceId={workspaceId} />
        ) : null}
      </section>
    </div>
  );
}
