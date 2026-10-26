import { randomUUID } from "node:crypto";
import { parseWorkspaceId } from "@contextvault/domain";
import { afterAll, describe, expect, it } from "vitest";
import { createTenantFixture } from "./tenant-fixture";

// Pool size 1: every transaction reuses the same physical connection.
const fx = createTenantFixture(1);
afterAll(() => fx.close());

describe("connection reuse", () => {
  it("does not leak context into the next transaction, committed or rolled back", async () => {
    const user = await fx.seedUser();
    const ws = await fx.createWorkspace(user);
    const settings =
      "select current_setting('app.user_id', true) as u, current_setting('app.workspace_id', true) as w";

    const own = await fx.queryAs({ userId: user, workspaceId: ws }, "select id from workspaces");
    expect(own).toHaveLength(1);

    // The setting reads back as '' (not NULL) after its transaction ends; policies must treat it as unset.
    expect(await fx.queryAs(null, settings)).toEqual([{ u: "", w: "" }]);
    expect(await fx.queryAs(null, "select id from workspaces")).toHaveLength(0);

    await expect(
      fx.queryAs({ userId: user, workspaceId: ws }, "select id from workspaces; select 1/0"),
    ).rejects.toThrow();
    expect(await fx.queryAs(null, "select id from workspaces")).toHaveLength(0);
  });

  it("applies the context of each unit of work, not the previous one", async () => {
    const [a, b] = [await fx.seedUser(), await fx.seedUser()];
    const [wsA, wsB] = [await fx.createWorkspace(a), await fx.createWorkspace(b)];
    const run = fx.persistence.unitOfWork.run.bind(fx.persistence.unitOfWork);
    expect(
      (await run({ userId: a, workspaceId: wsA }, (r) => r.workspaces.findById(wsA)))?.id,
    ).toBe(wsA);
    expect(await run({ userId: b }, (r) => r.workspaces.findById(wsA))).toBeNull();
    expect(
      (await run({ userId: b, workspaceId: wsB }, (r) => r.workspaces.findById(wsB)))?.id,
    ).toBe(wsB);
  });
});

describe("unit of work", () => {
  it("rolls back every write when the work throws, and the connection stays usable", async () => {
    const user = await fx.seedUser();
    const id = parseWorkspaceId(randomUUID());
    const run = fx.persistence.unitOfWork.run.bind(fx.persistence.unitOfWork);
    await expect(
      run({ userId: user }, async (r) => {
        await r.workspaces.insert({ id, name: "doomed" }, user);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const left = await fx.owner.query("select 1 from workspaces where id = $1", [id]);
    expect(left.rowCount).toBe(0);
    expect(await run({ userId: user }, (r) => r.workspaces.listForUser(user))).toEqual([]);
  });

  it("exposes no raw client", () => {
    expect(Object.keys(fx.persistence).toSorted()).toEqual(["close", "unitOfWork"]);
  });
});
