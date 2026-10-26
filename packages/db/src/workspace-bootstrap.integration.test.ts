import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createTenantFixture, sqlState } from "./tenant-fixture";

const fx = createTenantFixture();
afterAll(() => fx.close());

const insertWorkspace =
  "insert into workspaces (id, name, created_by, created_at) values ($1, 'W', $2, $3)";
const addOwner = "insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')";

describe("workspace bootstrap window", () => {
  it("ignores a caller-chosen created_at, so the window cannot be forged or pre-set", async () => {
    const user = await fx.seedUser();
    const id = randomUUID();
    await fx.queryAs({ userId: user }, insertWorkspace, [id, user, "2000-01-01T00:00:00Z"]);
    const row = await fx.owner.query<{ fresh: boolean }>(
      "select created_at > now() - interval '1 minute' as fresh from workspaces where id = $1",
      [id],
    );
    expect(row.rows[0]?.fresh).toBe(true);
  });

  it("lets the creator add the owner row only in the creating transaction", async () => {
    const user = await fx.seedUser();
    const id = randomUUID();
    // A workspace committed without its owner row stays an orphan: the creator cannot claim it later.
    await fx.queryAs({ userId: user }, insertWorkspace, [id, user, null]);
    expect(await sqlState(fx.queryAs({ userId: user }, addOwner, [id, user]))).toBe("42501");
  });
});
