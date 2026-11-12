"use client";

import type { DocumentResponse } from "@contextvault/contracts";
import { useState } from "react";
import { guidanceFor } from "../messages";
import { DeleteControl, RetryButton } from "./document-actions";
import { StatusBadge } from "./status-badge";

const KIND = { "application/pdf": "PDF", "text/markdown": "Markdown", "text/plain": "Text" };

function formatSize(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// fallow-ignore-next-line complexity
export function DocumentRow({ doc, workspaceId }: { doc: DocumentResponse; workspaceId: string }) {
  const [confirming, setConfirming] = useState(false);
  const retryable = doc.status === "failed" && doc.error?.retryable === true;

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-line bg-surface p-4">
      <div className="min-w-0">
        <p className="truncate font-medium" title={doc.displayName}>
          {doc.displayName}
        </p>
        <p className="mt-0.5 text-xs tabular-nums text-muted">
          {KIND[doc.mime]} · {formatSize(doc.sizeBytes)} ·{" "}
          {new Date(doc.createdAt).toLocaleString()}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <StatusBadge status={doc.status} />
        {retryable ? <RetryButton doc={doc} workspaceId={workspaceId} /> : null}
        <DeleteControl
          doc={doc}
          workspaceId={workspaceId}
          confirming={confirming}
          onConfirming={setConfirming}
        />
      </div>
      {doc.error ? (
        <p className="basis-full text-sm">
          {guidanceFor(doc.error.code)}
          {doc.error.retryable ? "" : " Retrying will not help."}
        </p>
      ) : null}
    </li>
  );
}
