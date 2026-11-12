import { randomUUID } from "node:crypto";
import {
  type DocumentId,
  type DocumentVersionId,
  type EmbeddedChunkSet,
  parseDocumentId,
  type UserId,
  type WorkspaceId,
} from "@contextvault/domain";
import { withAxisEmbeddings } from "./embedded-chunk-set";
import type { Harness } from "./recovery-test-support";

export const chunkSet = (): EmbeddedChunkSet => {
  const sectionId = randomUUID();
  return withAxisEmbeddings({
    strategyId: "fixed-window",
    strategyVersion: 1,
    sections: [{ id: sectionId, ordinal: 0, page: null, startOffset: 0, endOffset: 20 }],
    chunks: [
      {
        id: randomUUID(),
        sectionId,
        ordinal: 0,
        content: "twenty characters ok",
        contentSha256: new Uint8Array(32).fill(7),
        tokenCount: 5,
        startOffset: 0,
        endOffset: 20,
      },
    ],
  });
};

export interface Doc {
  readonly documentId: DocumentId;
  readonly versionId: DocumentVersionId;
  readonly generation: number;
}

/** A document whose version is `status` (claimed through the real repository when it is running). */
export async function seedDoc(
  h: Harness,
  workspaceId: WorkspaceId,
  status: "uploaded" | "queued" | "parsing" | "chunking" | "ready" = "uploaded",
): Promise<Doc> {
  const versionId = await h.seed(workspaceId, {
    status: status === "queued" ? "queued" : "uploaded",
  });
  let generation = 0;
  if (status === "parsing" || status === "chunking" || status === "ready") {
    const claimed = await h.run(workspaceId, (r) => r.claim({ versionId }));
    if (claimed === null) throw new Error("seed was not claimable");
    generation = claimed.leaseGeneration;
    if (status !== "parsing") {
      await h.run(workspaceId, (r) =>
        r.transition({ versionId, leaseGeneration: generation, from: "parsing", to: "chunking" }),
      );
    }
    if (status === "ready") {
      await h.run(workspaceId, (r) =>
        r.activate({ versionId, leaseGeneration: generation, chunkSet: chunkSet() }),
      );
    }
  }
  const { rows } = await h.fx.fixture.query<{ document_id: string }>(
    "select document_id from document_versions where id = $1",
    [versionId],
  );
  const [row] = rows;
  if (row === undefined) throw new Error("seed has no version");
  return { documentId: parseDocumentId(row.document_id), versionId, generation };
}

/** The delete command's repository step, as the application role, in the caller's transaction. */
export const softDelete = (
  h: Harness,
  userId: UserId,
  workspaceId: WorkspaceId,
  documentId: DocumentId,
) =>
  h.fx.persistence.unitOfWork.run({ userId, workspaceId }, (r) =>
    r.documentDeletion.softDelete(workspaceId, documentId),
  );

export async function documentRow(h: Harness, documentId: string) {
  const { rows } = await h.fx.fixture.query<{
    deleted_at: Date | null;
    active_version_id: string | null;
  }>("select deleted_at, active_version_id from documents where id = $1", [documentId]);
  const [row] = rows;
  if (row === undefined) throw new Error("document not found");
  return row;
}

export async function derivedCounts(h: Harness, versionId: string) {
  const count = async (table: "sections" | "chunks") =>
    (await h.fx.fixture.query(`select 1 from ${table} where version_id = $1`, [versionId])).rows
      .length;
  return { sections: await count("sections"), chunks: await count("chunks") };
}

/**
 * Polls until a backend is blocked behind another transaction's lock on this document's row. A
 * locker that finds the row locked takes the tuple lock on its current tuple, then waits on the
 * holder's transaction id (see `waitUntilBlocked`, which does the same for version rows).
 */
export async function waitUntilDocumentBlocked(h: Harness, documentId: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const { rowCount } = await h.fx.fixture.query(
      `select 1 from documents d
         join pg_locks t on t.locktype = 'tuple' and t.granted
           and t.relation = 'documents'::regclass
           and t.page = (d.ctid::text::point)[0]::int and t.tuple = (d.ctid::text::point)[1]::int
         join pg_locks w on w.pid = t.pid and w.locktype = 'transactionid' and not w.granted
         where d.id = $1`,
      [documentId],
    );
    if (rowCount !== null && rowCount > 0) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`no backend became blocked on the row lock of document ${documentId}`);
}
