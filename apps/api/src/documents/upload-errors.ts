import { UploadRejected, type UploadRejectionCode } from "@contextvault/domain";

export interface UploadStatus {
  readonly status: number;
  readonly code: string;
}

// The approved M1.3 status table. Interruptions (client gone, idle, total deadline) are separate
// internally but are all "the body did not arrive" to a client, so they share `upload.incomplete`.
const table: Record<UploadRejectionCode, UploadStatus> = {
  "upload.invalid_name": { status: 400, code: "upload.invalid_name" },
  "upload.unsupported_type": { status: 415, code: "upload.unsupported_type" },
  "upload.invalid_length": { status: 400, code: "upload.invalid_length" },
  "upload.empty": { status: 400, code: "upload.empty" },
  "upload.too_large": { status: 413, code: "upload.too_large" },
  "upload.content_mismatch": { status: 422, code: "upload.content_mismatch" },
  "upload.incomplete": { status: 400, code: "upload.incomplete" },
  "upload.client_disconnected": { status: 400, code: "upload.incomplete" },
  "upload.idle_timeout": { status: 400, code: "upload.incomplete" },
  "upload.deadline_exceeded": { status: 400, code: "upload.incomplete" },
  "upload.quota_documents": { status: 409, code: "upload.quota_documents" },
  "upload.quota_bytes": { status: 409, code: "upload.quota_bytes" },
  "storage.unavailable": { status: 503, code: "storage.unavailable" },
};

export const uploadStatusOf = (error: unknown): UploadStatus | undefined =>
  error instanceof UploadRejected ? table[error.code] : undefined;

/** Internal classes worth a log line: the client sees only `upload.incomplete`. */
export const isInterruption = (error: unknown): error is UploadRejected =>
  error instanceof UploadRejected &&
  ["upload.client_disconnected", "upload.idle_timeout", "upload.deadline_exceeded"].includes(
    error.code,
  );
