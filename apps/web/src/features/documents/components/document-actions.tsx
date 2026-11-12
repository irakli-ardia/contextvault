"use client";

import type { DocumentResponse } from "@contextvault/contracts";
import { useRef } from "react";
import { useDelete, useRetry } from "../hooks";
import { guidanceForError } from "../messages";

const control = "rounded-full border border-line px-3 py-1 text-xs disabled:opacity-60";

export function RetryButton({ doc, workspaceId }: { doc: DocumentResponse; workspaceId: string }) {
  const retry = useRetry(workspaceId);
  return (
    <>
      <button
        type="button"
        className={control}
        disabled={retry.isPending}
        onClick={() => retry.mutate(doc.id)}
      >
        {retry.isPending ? "Retrying…" : "Retry"}
      </button>
      {retry.error ? <ActionError error={retry.error} /> : null}
    </>
  );
}

function ActionError({ error }: { error: unknown }) {
  return (
    <p role="alert" className="basis-full text-sm">
      {guidanceForError(error)}
    </p>
  );
}

/** Delete with an inline confirmation: no modal, so focus and layout stay put. */
// fallow-ignore-next-line complexity
export function DeleteControl({
  doc,
  workspaceId,
  confirming,
  onConfirming,
}: {
  doc: DocumentResponse;
  workspaceId: string;
  confirming: boolean;
  onConfirming: (value: boolean) => void;
}) {
  const remove = useDelete(workspaceId);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      {/* Stays mounted so keyboard focus is never dropped; Cancel gets focus, then it returns here. */}
      <button
        ref={trigger}
        type="button"
        className={control}
        aria-label={`Delete ${doc.displayName}`}
        aria-expanded={confirming}
        onClick={() => onConfirming(true)}
      >
        Delete
      </button>
      {confirming ? (
        <div
          role="alertdialog"
          aria-label={`Confirm delete ${doc.displayName}`}
          className="mt-3 flex basis-full flex-wrap items-center gap-3 text-sm"
        >
          <span>Delete this document? This cannot be undone.</span>
          <button
            type="button"
            className={control}
            disabled={remove.isPending}
            onClick={() => remove.mutate(doc.id, { onSettled: () => onConfirming(false) })}
          >
            {remove.isPending ? "Deleting…" : "Confirm delete"}
          </button>
          <button
            type="button"
            className={control}
            // biome-ignore lint/a11y/noAutofocus: moves focus into the confirmation that just opened
            autoFocus
            onClick={() => {
              onConfirming(false);
              trigger.current?.focus();
            }}
          >
            Cancel
          </button>
        </div>
      ) : null}
      {remove.error ? <ActionError error={remove.error} /> : null}
    </>
  );
}
