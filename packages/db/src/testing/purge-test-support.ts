import {
  type DocumentStore,
  documentObjectKey,
  StorageError,
  type WorkspaceId,
} from "@contextvault/domain";
import { type Doc, seedDoc, softDelete } from "./deletion-test-support";
import type { Harness } from "./recovery-test-support";

export const hour = 3_600_000;

/** In-memory object store: `delete` is idempotent, and can be told to fail for chosen keys. */
export function memoryStore(failing: (key: string) => boolean = () => false) {
  const deleted: string[] = [];
  const store: DocumentStore = {
    put: async () => undefined,
    get: async () => null,
    head: async () => null,
    delete: async (key) => {
      if (failing(key)) throw new StorageError("storage.unavailable", true);
      deleted.push(key);
    },
  };
  return { store, deleted };
}

export const keyOf = (workspaceId: WorkspaceId, doc: Doc) =>
  documentObjectKey(workspaceId, doc.documentId, doc.versionId);

/** Moves the deletion into the past on the database clock, as if `ms` had gone by. */
export const ageDeletion = (h: Harness, documentId: string, ms: number) =>
  h.fx.fixture.query(
    "update documents set deleted_at = now() - $2 * interval '1 millisecond' where id = $1",
    [documentId, ms],
  );

/** A ready document with chunks, deleted through the real command, deleted `ageMs` ago. */
export async function deletedDoc(h: Harness, workspaceId: WorkspaceId, ageMs = 0): Promise<Doc> {
  const doc = await seedDoc(h, workspaceId, "ready");
  const owner = workspaceId === h.wsA ? h.userA : h.userB;
  await softDelete(h, owner, workspaceId, doc.documentId);
  if (ageMs > 0) await ageDeletion(h, doc.documentId, ageMs);
  return doc;
}

export async function purgedAt(h: Harness, documentId: string): Promise<Date | null> {
  const { rows } = await h.fx.fixture.query<{ purged_at: Date | null }>(
    "select purged_at from documents where id = $1",
    [documentId],
  );
  const [row] = rows;
  if (row === undefined) throw new Error("document not found");
  return row.purged_at;
}
