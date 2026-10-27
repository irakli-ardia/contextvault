import { expect } from "vitest";
import { TransactionOutcomeUnknown } from "../kernel/errors";
import { parseUserId, parseWorkspaceId } from "../kernel/ids";
import type { UnitOfWork } from "../kernel/unit-of-work";
import type { Actor } from "../workspaces/permissions";
import type { DocumentSummary } from "./document";
import { StorageError, UploadConflict, UploadReservationMissing } from "./errors";
import type { DocumentStore } from "./ports";
import type { uploadDocument } from "./upload-document";
import type { DocumentRepository, Sha256, UploadRepository, UploadServices } from "./upload-ports";

// In-memory ports for use-case tests. The domain imports no node:crypto, so the digest is a cheap
// stand-in over every byte in order; the real SHA-256 is checked in the packages/db integration test.
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

export const actor: Actor = {
  userId: parseUserId(uuid(1)),
  workspaceId: parseWorkspaceId(uuid(2)),
  role: "member",
};

type PutMode =
  | "ok"
  | "refuse"
  | "commitThenFail"
  | "failAfterBody"
  | "leakOnAbort"
  | "hangAfterBody";
interface Faults {
  put: PutMode;
  headFails: boolean;
  deleteFails: boolean;
  finalize:
    | "none"
    | "timeout"
    | "unknownCommit"
    | "throw"
    | "rolledBack"
    | "throwAfterCommit"
    | "conflict"
    | "quota";
  /** Makes `findById` (the commit check) throw. */
  readFails: boolean;
  releaseFails: boolean;
  /** `lostAck`: stored, then the acknowledgement is lost. `unknown`: not stored, outcome unknowable. */
  reserve: "none" | "rolledBack" | "lostAck" | "unknown";
}

function foldingSha256(): Sha256 {
  const acc = new Uint8Array(32);
  let index = 0;
  return {
    update(chunk) {
      for (const byte of chunk) {
        acc[index % 32] = ((acc[index % 32] ?? 0) * 31 + byte) & 0xff;
        index += 1;
      }
    },
    digest: () => acc,
  };
}

export function fakeUpload() {
  const faults: Faults = {
    put: "ok",
    headFails: false,
    deleteFails: false,
    finalize: "none",
    readFails: false,
    releaseFails: false,
    reserve: "none",
  };
  const objects = new Map<string, Uint8Array>();
  const reservations = new Map<string, number>();
  const documents = new Map<string, DocumentSummary & { sha: string; workspaceId: string }>();
  const sent = { bytes: 0 }; // bytes of the latest put that the store consumed
  const log: string[] = [];
  const timeouts: Array<number | undefined> = []; // the bound each transaction was given
  let open = false;
  let counter = 100;
  const guarded = <T>(name: string, work: () => T): T => {
    if (open) throw new Error(`${name} called inside a transaction`);
    log.push(name);
    return work();
  };
  const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

  const store: DocumentStore = {
    put: (key, body, length, options) =>
      guarded("put", async () => {
        if (faults.put === "refuse") throw new StorageError("storage.unavailable", true);
        if (objects.has(key)) throw new StorageError("storage.conflict", false);
        const chunks: Uint8Array[] = [];
        sent.bytes = 0;
        try {
          for await (const chunk of body) {
            chunks.push(chunk);
            sent.bytes += chunk.length;
          }
        } catch (error) {
          // A provider that kept the partial bytes would break the "incomplete means absent" premise.
          if (faults.put === "leakOnAbort") objects.set(key, new Uint8Array(sent.bytes));
          throw error;
        }
        const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        if (bytes.length !== length) throw new Error("fake store: wrong length");
        if (faults.put === "failAfterBody") throw new StorageError("storage.unavailable", true);
        if (faults.put === "hangAfterBody") {
          // The request is in flight and unanswered until the deadline aborts it; nothing landed.
          await new Promise<never>((_resolve, reject) => {
            const fail = () => reject(new StorageError("storage.unavailable", true));
            if (options?.signal?.aborted) fail();
            options?.signal?.addEventListener("abort", fail, { once: true });
          });
        }
        objects.set(key, bytes);
        if (faults.put === "commitThenFail") throw new StorageError("storage.unavailable", true);
      }),
    head: (key) =>
      guarded("head", async () => {
        if (faults.headFails) throw new StorageError("storage.unavailable", true);
        const found = objects.get(key);
        return found === undefined ? null : { length: found.length };
      }),
    delete: (key) =>
      guarded("delete", async () => {
        if (faults.deleteFails) throw new StorageError("storage.unavailable", true);
        objects.delete(key);
      }),
  };

  const uploads: UploadRepository = {
    async reserveUpload(input, quota) {
      if (faults.reserve === "rolledBack") throw new Error("deadlock detected");
      if (faults.reserve === "unknown") throw new TransactionOutcomeUnknown();
      if (reservations.size + documents.size >= quota.maxDocuments) {
        return { outcome: "quota", reason: "documents" };
      }
      reservations.set(input.versionId, input.declaredBytes);
      if (faults.reserve === "lostAck") throw new TransactionOutcomeUnknown();
      return { outcome: "reserved" };
    },
    async finalizeUpload(input) {
      if (faults.finalize === "throw") throw new Error("connection lost");
      if (faults.finalize === "timeout") {
        throw Object.assign(new Error("canceling statement due to statement timeout"), {
          code: "57014",
        });
      }
      if (faults.finalize === "unknownCommit") throw new TransactionOutcomeUnknown();
      if (faults.finalize === "rolledBack") throw new UploadReservationMissing();
      if (faults.finalize === "conflict") throw new UploadConflict();
      if (faults.finalize === "quota") return { outcome: "quota", reason: "bytes" };
      const sha = hex(input.contentSha256);
      const twin = [...documents.values()].find((d) => d.sha === sha);
      if (twin !== undefined) {
        const { sha: _sha, workspaceId: _w, ...document } = twin;
        return { outcome: "duplicate", document };
      }
      if (!reservations.delete(input.versionId)) throw new UploadReservationMissing();
      const document = {
        id: input.documentId,
        displayName: input.displayName,
        mime: input.mime,
        sizeBytes: input.sizeBytes,
        status: "uploaded" as const,
        createdAt: new Date(0),
      };
      documents.set(input.documentId, { ...document, sha, workspaceId: input.workspaceId });
      if (faults.finalize === "throwAfterCommit") throw new Error("commit acknowledgement lost");
      return { outcome: "created", document };
    },
    async releaseUpload(_workspaceId, versionId) {
      if (faults.releaseFails) throw new Error("database down");
      return reservations.delete(versionId);
    },
    listPendingUploads: async () => [],
  };
  const documentRepo: DocumentRepository = {
    list: async () => [],
    async findById(workspaceId, documentId) {
      if (faults.readFails) throw new Error("database down");
      const found = documents.get(documentId);
      if (found === undefined || found.workspaceId !== workspaceId) return null;
      const { sha: _sha, workspaceId: _w, ...document } = found;
      return document;
    },
  };
  const uow: UnitOfWork<{ uploads: UploadRepository; documents: DocumentRepository }> = {
    async run(_context, work, options) {
      timeouts.push(options?.timeoutMs);
      log.push("tx");
      open = true;
      try {
        return await work({ uploads, documents: documentRepo });
      } finally {
        open = false;
      }
    },
  };
  const services: UploadServices = { newId: () => uuid(counter++), newSha256: foldingSha256 };
  return { faults, objects, reservations, documents, log, store, uow, services, sent, timeouts };
}

/** A hand-driven `DeadlineSignal` (the domain has no `AbortController` typings). */
export function fakeDeadline(expired = false) {
  const listeners: Array<() => void> = [];
  const signal = {
    aborted: expired,
    addEventListener: (_type: "abort", listener: () => void) => {
      listeners.push(listener);
    },
  };
  return {
    signal,
    abort() {
      signal.aborted = true;
      for (const listener of listeners) listener();
    },
  };
}

export const enc = (s: string) => Uint8Array.from(Array.from(s, (c) => c.charCodeAt(0)));
export const pdf = enc("%PDF-1.7 hello");

export async function* chunked(data: Uint8Array, size = 4): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < data.length; i += size) yield data.slice(i, i + size);
}

export function command(over: Partial<Parameters<typeof uploadDocument>[1]> = {}, data = pdf) {
  return {
    actor,
    fileName: "report.pdf",
    contentType: "application/pdf",
    declaredBytes: data.length,
    body: chunked(data),
    ...over,
  };
}
export const rejection = (code: string, reservation: string) =>
  expect.objectContaining({ code, reservation });
