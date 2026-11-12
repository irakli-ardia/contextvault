"use client";

import { useRef } from "react";
import { useUpload } from "../hooks";
import { guidanceForError } from "../messages";

function Progress({ percent }: { percent: number }) {
  return (
    <>
      <progress
        className="h-2 w-40 accent-accent"
        max={100}
        value={percent}
        aria-label="Upload progress"
      />
      <span className="text-sm tabular-nums text-muted">{percent}%</span>
    </>
  );
}

// fallow-ignore-next-line complexity
export function UploadPanel({ workspaceId }: { workspaceId: string }) {
  const upload = useUpload(workspaceId);
  const input = useRef<HTMLInputElement>(null);
  const percent = Math.round(upload.progress * 100);

  return (
    <section
      aria-labelledby="upload-title"
      className="rounded-card border border-line bg-surface p-6"
    >
      <h2 id="upload-title" className="font-semibold">
        Upload a document
      </h2>
      <p className="mt-1 text-sm text-muted">PDF, Markdown or plain text, up to 10 MB.</p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <label
          htmlFor="document-file"
          className="rounded-full border border-line px-4 py-2 text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent"
        >
          {upload.isPending ? "Uploading…" : "Choose file"}
          <input
            id="document-file"
            ref={input}
            type="file"
            className="sr-only"
            accept=".pdf,.md,.markdown,.txt,application/pdf,text/markdown,text/plain"
            disabled={upload.isPending}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              // Cleared so choosing the same file again still fires a change.
              if (file) upload.mutate(file);
              if (input.current) input.current.value = "";
            }}
          />
        </label>
        {upload.isPending ? <Progress percent={percent} /> : null}
      </div>
      <div role="status" aria-live="polite" className="mt-3 text-sm">
        {upload.isSuccess ? <p>Uploaded. Processing has started.</p> : null}
      </div>
      {upload.isError ? (
        <p role="alert" className="mt-3 text-sm">
          {guidanceForError(upload.error)}
        </p>
      ) : null}
    </section>
  );
}
