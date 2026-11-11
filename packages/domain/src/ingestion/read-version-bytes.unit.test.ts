import { describe, expect, it } from "vitest";
import { StorageError } from "../documents/errors";
import type { DocumentStore } from "../documents/ports";
import { documentObjectKey } from "../documents/storage-key";
import { parseDocumentId, parseDocumentVersionId, parseWorkspaceId } from "../kernel/ids";
import { type ParseSourceUnitOfWork, readVersionBytes } from "./read-version-bytes";
import { StageFailure } from "./stage-runner";

const ws = parseWorkspaceId("00000000-0000-4000-8000-000000000001");
const doc = parseDocumentId("00000000-0000-4000-8000-000000000002");
const ver = parseDocumentVersionId("00000000-0000-4000-8000-000000000003");
const signal = {
  aborted: false,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};

function setup(found: boolean, get: DocumentStore["get"]) {
  const keys: string[] = [];
  let open = false;
  const uow: ParseSourceUnitOfWork = {
    run: async (context, work) => {
      expect(context.workspaceId).toBe(ws);
      open = true;
      try {
        return await work({
          parseSource: { findParseSource: async () => (found ? { documentId: doc } : null) },
        });
      } finally {
        open = false;
      }
    },
  };
  const unused = async (): Promise<never> => {
    throw new Error("unused");
  };
  const store: DocumentStore = {
    put: unused,
    head: unused,
    delete: unused,
    get: async (key, options) => {
      expect(open).toBe(false); // no network call inside the transaction
      keys.push(key);
      return get(key, options);
    },
  };
  return { keys, deps: { uow, store } };
}
const input = { workspaceId: ws, versionId: ver, maxBytes: 10, signal };
const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected rejection");
};

describe("readVersionBytes", () => {
  it("reads the object at the key derived from the workspace's own ids", async () => {
    const { deps, keys } = setup(true, async () => new Uint8Array([1]));
    expect(await readVersionBytes(deps, input)).toEqual(new Uint8Array([1]));
    expect(keys).toEqual([documentObjectKey(ws, doc, ver)]);
  });

  it("fails without touching storage when the document is gone or deleted", async () => {
    const { deps, keys } = setup(false, async () => new Uint8Array());
    const error = await failure(readVersionBytes(deps, input));
    expect(error).toMatchObject({ code: "document.unavailable", retryable: false });
    expect(keys).toEqual([]);
  });

  it("maps a missing object and storage errors to stable stage codes", async () => {
    const missing = await failure(readVersionBytes(setup(true, async () => null).deps, input));
    expect(missing).toMatchObject({ code: "storage.missing", retryable: false });
    const down = setup(true, async () => {
      throw new StorageError("storage.unavailable", true);
    });
    expect(await failure(readVersionBytes(down.deps, input))).toMatchObject({
      code: "storage.unavailable",
      retryable: true,
    });
    const big = setup(true, async () => {
      throw new StorageError("storage.too_large", false);
    });
    const error = await failure(readVersionBytes(big.deps, input));
    expect(error).toBeInstanceOf(StageFailure);
    expect(error).toMatchObject({ code: "storage.too_large", retryable: false });
  });
});
