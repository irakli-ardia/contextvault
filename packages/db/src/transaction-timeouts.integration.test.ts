import { loadDatabaseEnv } from "@contextvault/config";
import { type UserId, WorkspaceAccessDenied, type WorkspaceId } from "@contextvault/domain";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "./client";
import { establishContext } from "./context";
import { newUpload, reserveInput, roomy } from "./document-fixture";
import { createRepositories } from "./repositories/index";
import { postgresErrorCode } from "./repositories/workspaces/postgres-error";
import { createTenantFixture } from "./tenant-fixture";
import { applyTimeout } from "./unit-of-work";

const fx = createTenantFixture(6);
const uow = fx.persistence.unitOfWork;
// One connection: the next borrower is always the same session, so a leaked setting would show.
const single = createDatabase({ connectionString: loadDatabaseEnv().DATABASE_URL, poolSize: 1 });

let user: UserId;
let ws: WorkspaceId;
const context = () => ({ userId: user, workspaceId: ws });
const pendingIds = async () =>
  (await fx.owner.query("select id from pending_uploads where workspace_id = $1", [ws])).rows.map(
    (row: { id: string }) => row.id,
  );

beforeAll(async () => {
  user = await fx.seedUser();
  ws = await fx.createWorkspace(user);
});
afterAll(async () => {
  await single.close();
  await fx.close();
});

describe("bounded transactions", () => {
  it("an advisory-lock wait ends at the bound and the waiter writes nothing", async () => {
    const holding = newUpload(ws, user);
    const waiting = newUpload(ws, user);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked = () => {};
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    // The first transaction takes the per-workspace quota lock and keeps it.
    const holder = uow.run(context(), async (r) => {
      await r.uploads.reserveUpload(reserveInput(holding), roomy);
      locked();
      await gate;
    });
    await isLocked;
    const started = Date.now();
    const error = await uow
      .run(context(), (r) => r.uploads.reserveUpload(reserveInput(waiting), roomy), {
        timeoutMs: 300,
      })
      .catch((e: unknown) => e);
    expect(postgresErrorCode(error)).toBe("57014"); // query_canceled: the wait is part of the statement
    expect(Date.now() - started).toBeLessThan(5_000);
    release();
    await holder;
    expect(await pendingIds()).toEqual([holding.versionId]);
  });

  it("a statement timeout cancels the statement and rolls the transaction back", async () => {
    const upload = newUpload(ws, user);
    const error = await single.db
      .transaction(async (tx) => {
        await applyTimeout(tx, 200);
        await establishContext(tx, context());
        await createRepositories(tx).uploads.reserveUpload(reserveInput(upload), roomy);
        await tx.execute(sql`select pg_sleep(5)`);
      })
      .catch((e: unknown) => e);
    expect(postgresErrorCode(error)).toBe("57014");
    expect(await pendingIds()).not.toContain(upload.versionId);
  });

  it("the bound is transaction-local: the next borrower of the connection gets the role default", async () => {
    const setting = async () =>
      (
        await single.db.execute<{ s: string }>(
          sql`select current_setting('statement_timeout') as s`,
        )
      ).rows[0]?.s;
    const before = await setting();
    const inside = await single.db.transaction(async (tx) => {
      await applyTimeout(tx, 1234);
      return (
        await tx.execute<{ s: string }>(sql`select current_setting('statement_timeout') as s`)
      ).rows[0]?.s;
    });
    expect([inside, await setting()]).toEqual(["1234ms", before]);
  });

  it("keeps the tenant context and its membership proof under a bound", async () => {
    const stranger = await fx.seedUser();
    const upload = newUpload(ws, user);
    const reserved = await uow.run(
      context(),
      (r) => r.uploads.reserveUpload(reserveInput(upload), roomy),
      { timeoutMs: 5_000 },
    );
    expect(reserved.outcome).toBe("reserved");
    await expect(
      uow.run({ userId: stranger, workspaceId: ws }, async () => "ran", { timeoutMs: 5_000 }),
    ).rejects.toBeInstanceOf(WorkspaceAccessDenied);
    const seen = await fx.queryAs(
      { userId: stranger, workspaceId: ws },
      "select id from pending_uploads",
    );
    expect(seen).toEqual([]);
  });
});
