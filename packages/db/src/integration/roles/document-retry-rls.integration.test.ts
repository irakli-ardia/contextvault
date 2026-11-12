import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { seedDoc, softDelete } from "../../testing/deletion-test-support";
import { createIngestionHarness } from "../../testing/ingestion-test-support";
import { seedFailed } from "../../testing/retry-test-support";
import { sqlState } from "../../testing/tenant-fixture";

// What the application role can do with the retry grants, probed with raw SQL: the policies admit
// the retry transition and nothing wider, and the OR-ed policies of 0017 and 0019 cannot be
// combined into a path neither intends.
const h = await createIngestionHarness();
const { wsA, wsB, userA, userB } = h;
afterAll(() => h.close());

const as = (user: typeof userA, ws: typeof wsA) => ({ userId: user, workspaceId: ws });
const affected = async (ctx: ReturnType<typeof as>, text: string, values: unknown[]) =>
  (await h.fx.queryAs<{ id: string }>(ctx, `${text} returning 1 as id`, values)).length;
const denied = (ctx: ReturnType<typeof as>, text: string, values: unknown[]) =>
  sqlState(h.fx.queryAs(ctx, text, values));

const queue =
  "update document_versions set status = 'queued', attempt = 0, error_stage = null, error_code = null, error_retryable = null, lease_generation = lease_generation + 1 where id = $1";
const closed =
  "update document_versions set status = 'failed', error_code = 'document.deleted', error_retryable = false, error_stage = null where id = $1";

describe("the retry transition on document_versions", () => {
  it("admits a member of the workspace, for a failed retryable version of a live document", async () => {
    const doc = await seedFailed(h, wsA);
    expect(await affected(as(userA, wsA), queue, [doc.versionId])).toBe(1);
    expect(await h.row(doc.versionId)).toMatchObject({ status: "queued", attempt: 0 });
  });

  it("touches nothing for another workspace's user, or a non-member naming the workspace", async () => {
    const doc = await seedFailed(h, wsA);
    expect(await affected(as(userB, wsB), queue, [doc.versionId])).toBe(0);
    expect(await affected(as(userB, wsA), queue, [doc.versionId])).toBe(0);
    expect(await h.row(doc.versionId)).toMatchObject({ status: "failed", attempt: 3 });
  });

  it.each([
    ["not retryable", { retryable: false }],
    ["without a verdict", { retryable: null }],
  ])("touches nothing when the failure is %s", async (_name, options) => {
    const doc = await seedFailed(h, wsA, options);
    expect(await affected(as(userA, wsA), queue, [doc.versionId])).toBe(0);
  });

  it.each(["queued", "parsing", "chunking", "ready"] as const)(
    "touches nothing for a %s version",
    async (status) => {
      const doc = await seedDoc(h, wsA, status);
      expect(await affected(as(userA, wsA), queue, [doc.versionId])).toBe(0);
      expect((await h.row(doc.versionId)).status).toBe(status);
    },
  );

  it("touches nothing for a deleted document", async () => {
    const gone = await seedFailed(h, wsA);
    await softDelete(h, userA, wsA, gone.documentId);
    expect(await affected(as(userA, wsA), queue, [gone.versionId])).toBe(0);
  });

  it.each([
    [
      "without resetting the attempt",
      "status = 'queued', error_code = null, error_retryable = null, error_stage = null",
    ],
    ["keeping the recorded failure", "status = 'queued', attempt = 0"],
    [
      "into a running state",
      "status = 'parsing', attempt = 0, error_code = null, error_retryable = null, error_stage = null",
    ],
    [
      "straight to ready",
      "status = 'ready', attempt = 0, error_code = null, error_retryable = null, error_stage = null",
    ],
    [
      "to uploaded",
      "status = 'uploaded', attempt = 0, error_code = null, error_retryable = null, error_stage = null",
    ],
    ["to a retryable failure again", "attempt = 0, error_code = 'x'"],
  ])("refuses a result that is queued %s", async (_name, set) => {
    const doc = await seedFailed(h, wsA);
    const state = await denied(
      as(userA, wsA),
      `update document_versions set ${set} where id = $1`,
      [doc.versionId],
    );
    // Either the policy (42501) or, for an illegal transition, the lifecycle trigger (23514, fires first).
    expect(state).toMatch(/^(42501|23514)$/);
    expect(await h.row(doc.versionId)).toMatchObject({ status: "failed", attempt: 3 });
  });

  it("cannot reuse the closing policy to mark a failed version of a live document as deleted", async () => {
    const doc = await seedFailed(h, wsA);
    expect(await denied(as(userA, wsA), closed, [doc.versionId])).toBe("42501");
    expect(await h.row(doc.versionId)).toMatchObject({ error_code: "storage.unavailable" });
  });

  it("cannot revive a closed version of a deleted document", async () => {
    const running = await seedDoc(h, wsA, "parsing");
    await h.fx.fixture.query("update documents set deleted_at = now() where id = $1", [
      running.documentId,
    ]);
    expect(await denied(as(userA, wsA), queue, [running.versionId])).toBe("42501");
    const failed = await seedFailed(h, wsA);
    await softDelete(h, userA, wsA, failed.documentId);
    expect(await affected(as(userA, wsA), queue, [failed.versionId])).toBe(0);
    expect((await h.row(running.versionId)).status).toBe("parsing");
  });
});

describe("the retry entry on outbox", () => {
  const insert =
    "insert into outbox (id, workspace_id, version_id, kind) values ($1, $2, $3, 'process_version')";
  const queued = async () => {
    const doc = await seedFailed(h, wsA);
    await h.fx.fixture.query(
      "update document_versions set status = 'queued', attempt = 0, error_code = null, error_retryable = null, error_stage = null where id = $1",
      [doc.versionId],
    );
    return doc;
  };

  it("admits the entry of a queued version with a fresh budget, for a member", async () => {
    const doc = await queued();
    expect(
      await denied(as(userA, wsA), insert, [randomUUID(), wsA, doc.versionId]),
    ).toBeUndefined();
  });

  it("refuses an entry for a failed version, a spent budget, or a running one", async () => {
    const failed = await seedFailed(h, wsA);
    expect(await denied(as(userA, wsA), insert, [randomUUID(), wsA, failed.versionId])).toBe(
      "42501",
    );
    const spent = await queued();
    await h.fx.fixture.query("update document_versions set attempt = 1 where id = $1", [
      spent.versionId,
    ]);
    expect(await denied(as(userA, wsA), insert, [randomUUID(), wsA, spent.versionId])).toBe(
      "42501",
    );
    const running = await seedDoc(h, wsA, "parsing");
    expect(await denied(as(userA, wsA), insert, [randomUUID(), wsA, running.versionId])).toBe(
      "42501",
    );
  });

  it("refuses an entry for a deleted document, another workspace, or a non-member", async () => {
    const gone = await queued();
    await h.fx.fixture.query("update documents set deleted_at = now() where id = $1", [
      gone.documentId,
    ]);
    expect(await denied(as(userA, wsA), insert, [randomUUID(), wsA, gone.versionId])).toBe("42501");
    const doc = await queued();
    expect(await denied(as(userB, wsB), insert, [randomUUID(), wsB, doc.versionId])).toBe("42501");
    expect(await denied(as(userB, wsA), insert, [randomUUID(), wsA, doc.versionId])).toBe("42501");
  });

  it("still gives the application role no way to read, change or remove outbox rows", async () => {
    const doc = await queued();
    for (const text of [
      "select id from outbox",
      "update outbox set dispatched_at = now()",
      "update outbox set available_at = now()",
      "delete from outbox",
    ]) {
      expect(await denied(as(userA, wsA), text, []), text).toBe("42501");
    }
    expect(doc.versionId).toBeDefined();
  });
});
