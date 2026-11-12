import type { DocumentStatus } from "@contextvault/contracts";

const LABELS: Record<DocumentStatus, string> = {
  uploaded: "Queued",
  queued: "Queued",
  parsing: "Parsing",
  chunking: "Chunking",
  processed: "Finishing",
  ready: "Ready",
  failed: "Failed",
};

const TONES: Record<DocumentStatus, string> = {
  ready: "border-accent text-accent",
  failed: "border-ink font-semibold text-ink",
  uploaded: "border-line text-muted",
  queued: "border-line text-muted",
  parsing: "border-line text-ink",
  chunking: "border-line text-ink",
  processed: "border-line text-ink",
};

// Text carries the state; colour only reinforces it.
export function StatusBadge({ status }: { status: DocumentStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 font-mono text-xs ${TONES[status]}`}
    >
      {LABELS[status]}
    </span>
  );
}
