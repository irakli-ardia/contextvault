"use client";

import Link from "next/link";
import { guidanceForError, isSessionEnded } from "../messages";

// Same box as a real row, so nothing shifts when data lands.
export function RowPlaceholder() {
  return (
    <li className="rounded-card border border-line bg-surface p-4" aria-hidden="true">
      <p className="font-medium text-muted">Loading document…</p>
      <p className="mt-0.5 text-xs text-muted">PDF · 0 KB</p>
    </li>
  );
}

export function LoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div role="alert" className="mt-4 rounded-card border border-line bg-surface p-4 text-sm">
      <p>{guidanceForError(error)}</p>
      {isSessionEnded(error) ? (
        <Link href="/login" className="mt-2 inline-block underline">
          Sign in
        </Link>
      ) : (
        <button
          type="button"
          className="mt-2 rounded-full border border-line px-3 py-1 text-xs"
          onClick={onRetry}
        >
          Try again
        </button>
      )}
    </div>
  );
}

export function EmptyLibrary() {
  return (
    <p className="mt-4 rounded-card border border-dashed border-line p-8 text-center text-sm text-muted">
      No documents yet. Upload a PDF, Markdown or text file to get started.
    </p>
  );
}
