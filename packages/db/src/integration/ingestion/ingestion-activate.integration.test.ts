import { randomUUID } from "node:crypto";
import {
  type DocumentVersionId,
  type EmbeddedChunkSet,
  parseDocumentVersionId,
  type WorkspaceId,
} from "@contextvault/domain";
import { afterAll, describe, expect, it } from "vitest";
import { withAxisEmbeddings } from "../../testing/embedded-chunk-set";
import { createIngestionHarness } from "../../testing/ingestion-test-support";
import { sqlState } from "../../testing/tenant-fixture";

// Activation: the one transaction that makes a version ready, through the real worker role.
const h = await createIngestionHarness();
const { wsA, wsB, run } = h;
afterAll(() => h.close());

const text = "ქართული ტექსტი 😀 and more words";
function chunkSet(content = text, overrides: { secondOrdinal?: number } = {}): EmbeddedChunkSet {
  const sectionId = randomUUID();
  const chunk = (ordinal: number, start: number, end: number) => ({
    id: randomUUID(),
    sectionId,
    ordinal,
    content: content.slice(start, end),
    contentSha256: new Uint8Array(32).fill(7),
    tokenCount: 3,
    startOffset: start,
    endOffset: end,
  });
  return withAxisEmbeddings({
    strategyId: "fixed-window",
    strategyVersion: 1,
    sections: [
      { id: sectionId, ordinal: 0, page: null, startOffset: 0, endOffset: content.length },
    ],
    chunks: [chunk(0, 0, 14), chunk(overrides.secondOrdinal ?? 1, 10, content.length)],
  });
}

async function chunking(): Promise<{ id: DocumentVersionId; gen: number }> {
  const id = await h.seed(wsA);
  const claimed = await run(wsA, (r) => r.claim({ versionId: id }));
  if (claimed === null) throw new Error("seed was not claimable");
  const gen = claimed.leaseGeneration;
  await run(wsA, (r) =>
    r.transition({ versionId: id, leaseGeneration: gen, from: "parsing", to: "chunking" }),
  );
  return { id, gen };
}
const activate = (
  id: DocumentVersionId,
  leaseGeneration: number,
  set: EmbeddedChunkSet = chunkSet(),
  ws: WorkspaceId = wsA,
) => run(ws, (r) => r.activate({ versionId: id, leaseGeneration, chunkSet: set }));
const q = async <T extends Record<string, unknown>>(sql: string, id: string) =>
  (await h.fx.fixture.query<T>(sql, [id])).rows;
const counts = async (id: string) => ({
  sections: (await q("select 1 from sections where version_id = $1", id)).length,
  chunks: (await q("select 1 from chunks where version_id = $1", id)).length,
  active: (
    await q<{ a: string | null }>(
      "select d.active_version_id as a from documents d join document_versions v on v.document_id = d.id where v.id = $1",
      id,
    )
  )[0]?.a,
});

describe("activate", () => {
  it("makes the version ready with its sections, chunks and the document's active version", async () => {
    const { id, gen } = await chunking();
    expect(await activate(id, gen)).toBe(true);

    expect(await h.row(id)).toMatchObject({ status: "ready", lease_generation: gen });
    expect(await counts(id)).toEqual({ sections: 1, chunks: 2, active: id });
    const rows = await q<{
      ordinal: number;
      content: string;
      start_offset: number;
      end_offset: number;
      strategy_id: string;
    }>(
      "select ordinal, content, start_offset, end_offset, strategy_id from chunks where version_id = $1 order by ordinal",
      id,
    );
    expect(rows.map((r) => r.content)).toEqual([text.slice(0, 14), text.slice(10)]);
    expect(rows.map((r) => text.slice(r.start_offset, r.end_offset))).toEqual(
      rows.map((r) => r.content),
    );
    expect(rows[0]?.strategy_id).toBe("fixed-window");
    // Every chunk has its vector, stored with the model that produced it.
    expect(
      await q(
        `select e.model from chunk_embeddings e join chunks c on c.id = e.chunk_id
         where c.version_id = $1`,
        id,
      ),
    ).toEqual([{ model: "test-model" }, { model: "test-model" }]);
  });

  it("refuses a set whose embeddings do not match its chunks, writing nothing", async () => {
    const { id, gen } = await chunking();
    const short = { ...chunkSet(), embeddings: [] };
    await expect(activate(id, gen, short)).rejects.toThrow("one embedding per chunk");
    expect(await h.row(id)).toMatchObject({ status: "chunking" });
    expect(await counts(id)).toEqual({ sections: 0, chunks: 0, active: null });
  });

  it("is a no-op when replayed: no second copy of any chunk", async () => {
    const { id, gen } = await chunking();
    expect(await activate(id, gen)).toBe(true);
    expect(await activate(id, gen)).toBe(false);
    expect(await counts(id)).toEqual({ sections: 1, chunks: 2, active: id });
  });

  it("writes nothing for a stale generation or another workspace", async () => {
    const { id, gen } = await chunking();
    expect(await activate(id, gen + 1)).toBe(false);
    expect(await activate(id, gen, chunkSet(), wsB)).toBe(false);
    expect(await h.row(id)).toMatchObject({ status: "chunking" });
    expect(await counts(id)).toEqual({ sections: 0, chunks: 0, active: null });
  });

  it("writes nothing for a deleted document", async () => {
    const { id, gen } = await chunking();
    await h.fx.fixture.query(
      "update documents set deleted_at = now() where id = (select document_id from document_versions where id = $1)",
      [id],
    );
    expect(await activate(id, gen)).toBe(false);
    expect(await h.row(id)).toMatchObject({ status: "chunking" });
    expect(await counts(id)).toEqual({ sections: 0, chunks: 0, active: null });
  });

  it("is atomic: a rejected chunk rolls back the status, sections and active version", async () => {
    const { id, gen } = await chunking();
    // Two chunks with the same ordinal violate the chunk identity.
    expect(await sqlState(activate(id, gen, chunkSet(text, { secondOrdinal: 0 })))).toBe("23505");
    expect(await h.row(id)).toMatchObject({ status: "chunking", lease_generation: gen });
    expect(await counts(id)).toEqual({ sections: 0, chunks: 0, active: null });
  });

  it("rejects blank content at the database", async () => {
    const { id, gen } = await chunking();
    expect(await sqlState(activate(id, gen, chunkSet("x".padEnd(40, " "))))).toBe("23514");
    expect(await h.row(id)).toMatchObject({ status: "chunking" });
  });

  it("rejects an empty chunk set before writing anything", async () => {
    const { id, gen } = await chunking();
    const empty = { ...chunkSet(), chunks: [] };
    await expect(activate(id, gen, empty)).rejects.toThrow("at least one");
    await expect(activate(id, gen, { ...chunkSet(), sections: [] })).rejects.toThrow(
      "at least one",
    );
    expect(await h.row(id)).toMatchObject({ status: "chunking", lease_generation: gen });
    expect(await counts(id)).toEqual({ sections: 0, chunks: 0, active: null });
  });

  it("keeps the same document's active version when a replacement's activation fails", async () => {
    const first = await chunking();
    expect(await activate(first.id, first.gen)).toBe(true);

    const [{ document_id: documentId } = { document_id: "" }] = await q<{ document_id: string }>(
      "select document_id from document_versions where id = $1",
      first.id,
    );
    const replacement = parseDocumentVersionId(randomUUID());
    await h.fx.fixture.query(
      `insert into document_versions (id, document_id, workspace_id, version_no, storage_key)
       values ($1::uuid, $2::uuid, $3::uuid, 2, 'ws/' || $3::text || '/doc/' || $2::text || '/v/' || $1::text)`,
      [replacement, documentId, wsA],
    );
    const claimed = await run(wsA, (r) => r.claim({ versionId: replacement }));
    if (claimed === null) throw new Error("replacement was not claimable");
    const gen = claimed.leaseGeneration;
    await run(wsA, (r) =>
      r.transition({
        versionId: replacement,
        leaseGeneration: gen,
        from: "parsing",
        to: "chunking",
      }),
    );

    await expect(
      activate(replacement, gen, chunkSet(text, { secondOrdinal: 0 })),
    ).rejects.toThrow();
    expect(await h.row(replacement)).toMatchObject({ status: "chunking" });
    expect((await counts(replacement)).chunks).toBe(0);
    expect((await counts(first.id)).active).toBe(first.id);

    // The same document then moves to the replacement only when its activation succeeds.
    expect(await activate(replacement, gen)).toBe(true);
    expect((await counts(replacement)).active).toBe(replacement);
    expect((await counts(first.id)).chunks).toBe(2);
  });

  it("refuses a version that is not in chunking, whatever the generation", async () => {
    const id = await h.seed(wsA);
    const claimed = await run(wsA, (r) => r.claim({ versionId: id }));
    expect(await activate(id, claimed?.leaseGeneration ?? -1)).toBe(false);
    expect(await h.row(id)).toMatchObject({ status: "parsing" });
    expect(await counts(id)).toEqual({ sections: 0, chunks: 0, active: null });
  });

  it("never moves the active pointer back to an older version that finishes later", async () => {
    const older = await chunking();
    const [{ document_id: documentId } = { document_id: "" }] = await q<{ document_id: string }>(
      "select document_id from document_versions where id = $1",
      older.id,
    );
    const newer = parseDocumentVersionId(randomUUID());
    await h.fx.fixture.query(
      `insert into document_versions (id, document_id, workspace_id, version_no, storage_key)
       values ($1::uuid, $2::uuid, $3::uuid, 2, 'ws/' || $3::text || '/doc/' || $2::text || '/v/' || $1::text)`,
      [newer, documentId, wsA],
    );
    const claimed = await run(wsA, (r) => r.claim({ versionId: newer }));
    const gen = claimed?.leaseGeneration ?? -1;
    await run(wsA, (r) =>
      r.transition({ versionId: newer, leaseGeneration: gen, from: "parsing", to: "chunking" }),
    );

    expect(await activate(newer, gen)).toBe(true);
    expect(await activate(older.id, older.gen)).toBe(true);
    expect(await h.row(older.id)).toMatchObject({ status: "ready" });
    expect((await counts(older.id)).active).toBe(newer);
  });

  it("does not regress the pointer when a newer version commits while the older one waits", async () => {
    const older = await chunking();
    const [{ document_id: documentId } = { document_id: "" }] = await q<{ document_id: string }>(
      "select document_id from document_versions where id = $1",
      older.id,
    );
    const newer = randomUUID();
    await h.fx.fixture.query(
      `insert into document_versions (id, document_id, workspace_id, version_no, storage_key, status)
       values ($1::uuid, $2::uuid, $3::uuid, 2, 'ws/' || $3::text || '/doc/' || $2::text || '/v/' || $1::text, 'ready')`,
      [newer, documentId, wsA],
    );
    // The newer activation, committing late: it holds the document row until released.
    const newerTx = await h.fx.fixture.connect();
    try {
      await newerTx.query("begin");
      await newerTx.query("update documents set active_version_id = $1 where id = $2", [
        newer,
        documentId,
      ]);
      const olderDone = activate(older.id, older.gen);
      // Wait until the older activation is blocked on the document row, not for a fixed time.
      await expect
        .poll(
          async () =>
            (
              await h.fx.fixture.query(
                "select 1 from pg_locks where not granted and locktype in ('transactionid', 'tuple')",
              )
            ).rowCount,
        )
        .toBeGreaterThan(0);
      await newerTx.query("commit");
      expect(await olderDone).toBe(true);
    } finally {
      newerTx.release();
    }
    expect(await h.row(older.id)).toMatchObject({ status: "ready" });
    expect((await counts(older.id)).active).toBe(newer);
  });
});
