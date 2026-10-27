import { S3ServiceException } from "@aws-sdk/client-s3";
import { StorageError } from "@contextvault/domain";

export const isMissing = (error: unknown): boolean =>
  error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404;

// Provider text is dropped: it can carry the endpoint, bucket, or key. Server-side 5xx, 408, and
// 429 and every transport failure (refused, reset, timeout) may succeed on repeat; other statuses
// (bad credentials, no bucket, malformed request) will not until configuration changes.
export function toStorageError(error: unknown): StorageError {
  if (!(error instanceof S3ServiceException)) return new StorageError("storage.unavailable", true);
  const status = error.$metadata.httpStatusCode ?? 0;
  // 412: `If-None-Match: *` found an object already at the key.
  if (status === 412) return new StorageError("storage.conflict", false);
  return status >= 500 || status === 408 || status === 429
    ? new StorageError("storage.unavailable", true)
    : new StorageError("storage.rejected", false);
}
