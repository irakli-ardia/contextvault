import { PassThrough, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { S3Env } from "@contextvault/config";
import {
  type DeadlineSignal,
  type DocumentStore,
  parseStorageKey,
  StorageError,
  type StoredObject,
} from "@contextvault/domain";
import { lengthGuard } from "./length-guard";
import { isMissing, toStorageError } from "./storage-errors";

export interface S3DocumentStoreOptions {
  /** Largest object `put` accepts; the use case owns the product limit, this is the backstop. */
  readonly maxBytes: number;
  readonly putTimeoutMs?: number;
  readonly getTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
}

export type S3DocumentStore = DocumentStore & {
  onModuleDestroy(): void;
  assertBucket(): Promise<void>;
};

const PUT_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 10_000;
const GET_TIMEOUT_MS = 60_000;

// Private bucket, path-style addressing, credentials from validated configuration only. The
// adapter never creates the bucket, sets an ACL, or issues a URL. One attempt per call: a stream
// cannot be replayed, and retrying delete/head belongs to the caller (sweeper, M1.4).
export function createS3DocumentStore(
  env: S3Env,
  options: S3DocumentStoreOptions,
): S3DocumentStore {
  const client = new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    forcePathStyle: true,
    credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
    maxAttempts: 1,
    // The default adds a CRC32 trailer (aws-chunked body), which on a failing stream raises an
    // uncaught error and never settles the call (spike S5).
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    requestHandler: {
      connectionTimeout: 5_000,
      requestTimeout: 30_000,
      throwOnRequestTimeout: true,
    },
  });
  const Bucket = env.S3_BUCKET;
  const putTimeout = options.putTimeoutMs ?? PUT_TIMEOUT_MS;
  const requestTimeout = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const getTimeout = options.getTimeoutMs ?? GET_TIMEOUT_MS;

  // `missing` is the answer for a provider 404, for calls where "not there" is not a failure.
  async function call<T, M = never>(
    run: (signal: AbortSignal) => Promise<T>,
    ms: number,
    missing?: { readonly value: M },
  ): Promise<T | M> {
    try {
      return await run(AbortSignal.timeout(ms));
    } catch (error) {
      if (missing && isMissing(error)) return missing.value;
      throw toStorageError(error);
    }
  }

  return {
    onModuleDestroy: () => client.destroy(),

    // Startup check, not per upload. A missing bucket is `storage.rejected` (configuration) and
    // an unreachable provider is `storage.unavailable` (retryable). Never creates the bucket.
    async assertBucket() {
      await call(
        (abortSignal) => client.send(new HeadBucketCommand({ Bucket }), { abortSignal }),
        requestTimeout,
      );
    },

    async put(rawKey, body, length, putOptions) {
      const Key = parseStorageKey(rawKey);
      if (!Number.isSafeInteger(length) || length < 1 || length > options.maxBytes) {
        throw new StorageError("storage.invalid_length", false);
      }
      const stop = new AbortController();
      // The caller's deadline aborts the request like a failing body; the outcome is then unknown.
      putOptions?.signal?.addEventListener("abort", () => stop.abort(), { once: true });
      if (putOptions?.signal?.aborted) stop.abort();
      const guarded = new PassThrough();
      // A failing body must abort the request: the SDK neither settles nor cleans up by itself.
      let bodyError: unknown;
      // A Readable is piped as is, so pipeline sees its destruction (a cancel) even while paused.
      const source = body instanceof Readable ? body : Readable.from(body);
      pipeline(source, lengthGuard(length), guarded).catch((error: unknown) => {
        bodyError ??= error;
        stop.abort();
      });
      try {
        await call(
          (abortSignal) =>
            client.send(
              // Atomic create-only: an existing object is never replaced (412, spike on SeaweedFS).
              new PutObjectCommand({
                Bucket,
                Key,
                Body: guarded,
                ContentLength: length,
                IfNoneMatch: "*",
              }),
              { abortSignal: AbortSignal.any([abortSignal, stop.signal]) },
            ),
          putTimeout,
        );
      } catch (error) {
        guarded.destroy();
        throw bodyError ?? error;
      }
    },

    async get(rawKey, getOptions) {
      const Key = parseStorageKey(rawKey);
      const { maxBytes } = getOptions;
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
        throw new StorageError("storage.invalid_length", false);
      }
      return call(
        async (abortSignal) => {
          const signals = [
            abortSignal,
            ...(getOptions.signal ? [toAbortSignal(getOptions.signal)] : []),
          ];
          const response = await client.send(new GetObjectCommand({ Bucket, Key }), {
            abortSignal: AbortSignal.any(signals),
          });
          const { Body: body, ContentLength: length } = response;
          if (!(body instanceof Readable) || length === undefined) {
            throw new StorageError("storage.rejected", false);
          }
          if (length > maxBytes) {
            body.destroy();
            throw new StorageError("storage.too_large", false);
          }
          // The declared length is not trusted: the count below is what bounds memory.
          const parts: Uint8Array[] = [];
          let seen = 0;
          for await (const chunk of body) {
            seen += chunk.length;
            if (seen > maxBytes) {
              body.destroy();
              throw new StorageError("storage.too_large", false);
            }
            parts.push(chunk);
          }
          if (seen !== length) throw new StorageError("storage.unavailable", true);
          return Buffer.concat(parts);
        },
        getTimeout,
        { value: null },
      );
    },

    async head(key) {
      const Key = parseStorageKey(key);
      const head = await call(
        (abortSignal) => client.send(new HeadObjectCommand({ Bucket, Key }), { abortSignal }),
        requestTimeout,
        { value: null },
      );
      return head === null ? null : toStored(head.ContentLength);
    },

    async delete(key) {
      const Key = parseStorageKey(key);
      await call(
        (abortSignal) => client.send(new DeleteObjectCommand({ Bucket, Key }), { abortSignal }),
        requestTimeout,
        { value: null },
      );
    },
  };
}

// The domain's signal type is structural; the SDK wants a real one.
function toAbortSignal(signal: DeadlineSignal): AbortSignal {
  const controller = new AbortController();
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", () => controller.abort(), { once: true });
  return controller.signal;
}

function toStored(length: number | undefined): StoredObject {
  if (length === undefined) throw new StorageError("storage.rejected", false);
  return { length };
}
