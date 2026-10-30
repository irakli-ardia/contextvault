import { randomUUID } from "node:crypto";
import {
  dispatchOutbox,
  type JobQueue,
  parseOutboxId,
  UploadConflict,
  type UserId,
  type WorkspaceId,
} from "@contextvault/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { finalizeInput, newUpload, reserveInput, roomy, seedDocument } from "./document-fixture";
import { createIngestionHarness } from "./ingestion-test-support";
import { sqlState } from "./tenant-fixture";

// The upload transaction writes the first outbox entry; the application role can do nothing else
// with the table. Real adapters throughout, as the application and worker roles.
const h = await createIngestionHarness();
const { fx, wsA, wsB, userA, userB } = h;
const run = fx.persistence.unitOfWork.run.bind(fx.persistence.unitOfWork);
const DENIED = "42501";

let outsider: UserId;
beforeAll(async () => {
  outsider = await fx.seedUser();
});
afterAll(() => h.close());

const inA = { userId: userA, workspaceId: wsA };
const upload = async (ws: WorkspaceId, user: UserId, seed?: string, quota = roomy) => {
  const u = newUpload(ws, user);
  await run({ userId: user, workspaceId: ws }, (r) =>
    r.uploads.reserveUpload(reserveInput(u), roomy),
  );
  const result = await run({ userId: user, workspaceId: ws }, (r) =>
    r.uploads.finalizeUpload(finalizeInput(u, seed), quota),
  );
  return { u, result };
};
const entries = async (versionIds: readonly string[]) =>
  (
    await fx.fixture.query<{ kind: string; workspace_id: string; dispatched_at: Date | null }>(
      "select kind, workspace_id, dispatched_at from outbox where version_id = any($1::uuid[])",
      [versionIds],
    )
  ).rows;

describe("finalize writes the outbox entry", () => {
  it("creates exactly one live process_version entry per upload", async () => {
    const { u, result } = await upload(wsA, userA);
    expect(result.outcome).toBe("created");
    expect(await entries([u.versionId])).toEqual([
      { kind: "process_version", workspace_id: wsA, dispatched_at: null },
    ]);
  });

  it("writes none for a duplicate or a quota refusal", async () => {
    await seedDocument(fx, wsA, userA, "twin");
    const dup = await upload(wsA, userA, "twin");
    const over = await upload(wsA, userA, "over", { maxDocuments: 0, maxBytes: 1 });
    expect([dup.result.outcome, over.result.outcome]).toEqual(["duplicate", "quota"]);
    expect(await entries([dup.u.versionId, over.u.versionId])).toEqual([]);
  });

  it("rolls back document, version and entry together, keeping the reservation", async () => {
    const taken = (await h.outboxRows((await seedDocument(fx, wsA, userA)).versionId))[0]?.id;
    const u = newUpload(wsA, userA);
    await run(inA, (r) => r.uploads.reserveUpload(reserveInput(u), roomy));
    // The entry is the last write: a primary-key clash there must undo everything before it.
    const failing = { ...finalizeInput(u), outboxId: parseOutboxId(taken ?? randomUUID()) };
    await expect(run(inA, (r) => r.uploads.finalizeUpload(failing, roomy))).rejects.toBeInstanceOf(
      UploadConflict,
    );
    const count = async (table: string, column: string, id: string) =>
      (await fx.fixture.query(`select 1 from ${table} where ${column} = $1`, [id])).rowCount;
    expect(await count("documents", "id", u.documentId)).toBe(0);
    expect(await count("document_versions", "id", u.versionId)).toBe(0);
    expect(await count("pending_uploads", "id", u.versionId)).toBe(1);
  });

  it("creates one entry when identical uploads finalize concurrently", async () => {
    const ups = Array.from({ length: 6 }, () => newUpload(wsB, userB));
    for (const u of ups)
      await run({ userId: userB, workspaceId: wsB }, (r) =>
        r.uploads.reserveUpload(reserveInput(u), roomy),
      );
    const results = await Promise.all(
      ups.map((u) =>
        run({ userId: userB, workspaceId: wsB }, (r) =>
          r.uploads.finalizeUpload(finalizeInput(u, "race"), roomy),
        ),
      ),
    );
    expect(results.filter((r) => r.outcome === "created")).toHaveLength(1);
    expect(await entries(ups.map((u) => u.versionId))).toHaveLength(1);
  });
});

describe("the application role's grant", () => {
  // A version without an entry: the seed's own entry is removed, so the insert under test is the
  // only one and a denial can only come from the policy or the grant.
  const bare = async () => {
    const { versionId } = await seedDocument(fx, wsA, userA);
    await fx.fixture.query("delete from outbox where version_id = $1", [versionId]);
    return versionId;
  };
  const insert = (
    context: { userId: string; workspaceId: string },
    ws: string,
    versionId: string,
    extra = "",
  ) =>
    sqlState(
      fx.queryAs(
        context,
        `insert into outbox (id, workspace_id, version_id, kind${extra && ", available_at"})
         values ($1, $2, $3, 'process_version'${extra && ", now()"})`,
        [randomUUID(), ws, versionId],
      ),
    );

  it("allows a member to queue an uploaded version of the context workspace", async () => {
    const versionId = await bare();
    expect(await insert(inA, wsA, versionId)).toBeUndefined();
    expect(await entries([versionId])).toHaveLength(1);
  });

  it("denies other workspaces, non-members and forged workspace ids", async () => {
    const versionId = await bare();
    const inB = { userId: userB, workspaceId: wsB };
    expect(await insert(inA, wsB, versionId)).toBe(DENIED); // row names another workspace
    expect(await insert(inB, wsB, versionId)).toBe(DENIED); // version is not in the context's workspace
    expect(await insert({ userId: userB, workspaceId: wsA }, wsA, versionId)).toBe(DENIED); // forged context
    expect(await insert({ userId: outsider, workspaceId: wsA }, wsA, versionId)).toBe(DENIED);
    expect(await insert({ userId: userA, workspaceId: wsB }, wsA, versionId)).toBe(DENIED);
    expect(await entries([versionId])).toEqual([]);
  });

  it("denies a version that is no longer uploaded", async () => {
    const versionId = await bare();
    await fx.fixture.query("update document_versions set status = 'queued' where id = $1", [
      versionId,
    ]);
    expect(await insert(inA, wsA, versionId)).toBe(DENIED);
  });

  it("denies setting available_at", async () => {
    expect(await insert(inA, wsA, await bare(), "available_at")).toBe(DENIED);
  });

  it("denies dispatched_at, SELECT, UPDATE and DELETE", async () => {
    const [{ versionId }, versionId2] = [await seedDocument(fx, wsA, userA), await bare()];
    const denied = (text: string) => sqlState(fx.queryAs(inA, text));
    expect(
      await sqlState(
        fx.queryAs(
          inA,
          `insert into outbox (id, workspace_id, version_id, kind, dispatched_at)
           values ($1, $2, $3, 'process_version', now())`,
          [randomUUID(), wsA, versionId2],
        ),
      ),
    ).toBe(DENIED);
    expect(await denied("select id from outbox")).toBe(DENIED);
    expect(
      await denied(`update outbox set dispatched_at = now() where version_id = '${versionId}'`),
    ).toBe(DENIED);
    expect(await denied(`delete from outbox where version_id = '${versionId}'`)).toBe(DENIED);
    expect(await entries([versionId])).toHaveLength(1);
  });
});

describe("hand-off to the worker", () => {
  it("lets the dispatcher queue the version and the worker claim it", async () => {
    await h.drainOutbox();
    const { u } = await upload(wsA, userA);
    const enqueued: string[] = [];
    const queue: JobQueue = { enqueue: async (job) => void enqueued.push(job.jobId) };

    const result = await dispatchOutbox(
      { source: h.ownSource, queue, uow: h.worker.unitOfWork },
      100,
    );
    expect(result).toMatchObject({ dispatched: 1 });
    expect(enqueued).toHaveLength(1);
    expect(await h.row(u.versionId)).toMatchObject({ status: "queued" });
    expect(await h.run(wsA, (r) => r.claim({ versionId: u.versionId }))).toEqual({
      leaseGeneration: 1,
      attempt: 1,
    });
  });
});
