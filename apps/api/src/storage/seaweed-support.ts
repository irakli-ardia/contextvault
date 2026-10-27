import { createHash, randomUUID } from "node:crypto";
import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { loadS3Env, type S3Env } from "@contextvault/config";
import {
  documentObjectKey,
  parseDocumentId,
  parseDocumentVersionId,
  parseWorkspaceId,
  type StorageKey,
} from "@contextvault/domain";
import { afterAll } from "vitest";
import { createS3DocumentStore } from "./s3-document-store";

// Runs against the Compose SeaweedFS and the bucket `pnpm run infra:up` creates. Keys are random, so concurrent runs
// never collide; every object a test makes is deleted in afterAll, even after a failure.
export const env: S3Env = loadS3Env();
export const MAX_OBJECT = 10 * 1024 * 1024;
export const store = createS3DocumentStore(env, { maxBytes: MAX_OBJECT });
export const raw = new S3Client({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  forcePathStyle: true,
  maxAttempts: 1,
  credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
});
const made: StorageKey[] = [];
export const trackedKey = (): StorageKey => {
  const key = documentObjectKey(
    parseWorkspaceId(randomUUID()),
    parseDocumentId(randomUUID()),
    parseDocumentVersionId(randomUUID()),
  );
  made.push(key);
  return key;
};
export const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
export const read = async (key: string): Promise<Buffer> => {
  const out = await raw.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
  return Buffer.from((await out.Body?.transformToByteArray()) ?? []);
};
export const exists = async (key: string): Promise<boolean> =>
  raw.send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: key })).then(
    () => true,
    () => false,
  );

afterAll(async () => {
  await Promise.allSettled(made.map((key) => store.delete(key)));
  store.onModuleDestroy();
  raw.destroy();
});
