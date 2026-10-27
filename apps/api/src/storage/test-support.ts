import { randomUUID } from "node:crypto";
import { addAbortSignal, Readable } from "node:stream";
import {
  documentObjectKey,
  parseDocumentId,
  parseDocumentVersionId,
  parseWorkspaceId,
  StorageError,
} from "@contextvault/domain";
import { afterEach } from "vitest";
import { type FakeS3, type Handler, SECRET, startFakeS3 } from "./fake-s3";
import { createS3DocumentStore } from "./s3-document-store";

export const MAX = 64 * 1024 * 1024;
export const newKey = () =>
  documentObjectKey(
    parseWorkspaceId(randomUUID()),
    parseDocumentId(randomUUID()),
    parseDocumentVersionId(randomUUID()),
  );

const open: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

export async function setup(handler: Handler, options: { putTimeoutMs?: number } = {}) {
  const fake: FakeS3 = await startFakeS3(handler);
  const store = createS3DocumentStore(fake.env, { maxBytes: MAX, ...options });
  open.push(fake.close, () => store.onModuleDestroy());
  return { fake, store };
}

export const ok: Handler = (request, response) => {
  request.on("end", () => response.writeHead(200, { etag: '"x"' }).end());
  request.resume();
};
export const status =
  (code: number): Handler =>
  (request, response) => {
    request.resume();
    response
      .writeHead(code, { "content-type": "application/xml" })
      .end(`<Error><Code>X</Code><Message>${SECRET} private-bucket</Message></Error>`);
  };
export async function* chunks(buffer: Buffer, size = 16_384): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < buffer.length; i += size) yield buffer.subarray(i, i + size);
}
export const rejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
};
export const codeOf = (error: unknown) =>
  error instanceof StorageError ? error.code : String(error);

// Cancelling a put means failing its body; this is how a caller's AbortSignal does it.
export const abortable = (source: AsyncIterable<Uint8Array>, signal: AbortSignal): Readable =>
  addAbortSignal(signal, Readable.from(source));
