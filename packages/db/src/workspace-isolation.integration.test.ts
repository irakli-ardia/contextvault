import { randomUUID } from "node:crypto";
import {
  AlreadyMember,
  parseUserId,
  parseWorkspaceId,
  UnknownUser,
  type UserId,
  WorkspaceAccessDenied,
  type WorkspaceId,
} from "@contextvault/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTenantFixture, sqlState } from "./tenant-fixture";

const fx = createTenantFixture();
const run = fx.persistence.unitOfWork.run.bind(fx.persistence.unitOfWork);

// u1 owns A, u2 owns B, u3 belongs to both.
let u1: UserId;
let u2: UserId;
let u3: UserId;
let wsA: WorkspaceId;
let wsB: WorkspaceId;

beforeAll(async () => {
  [u1, u2, u3] = await Promise.all([fx.seedUser(), fx.seedUser(), fx.seedUser()]);
  wsA = await fx.createWorkspace(u1, "A");
  wsB = await fx.createWorkspace(u2, "B");
  await run({ userId: u1, workspaceId: wsA }, (r) => r.workspaces.addMember(wsA, u3, "member"));
  await run({ userId: u2, workspaceId: wsB }, (r) => r.workspaces.addMember(wsB, u3, "member"));
});
afterAll(() => fx.close());

describe("reads under workspace A's context", () => {
  it("cannot see workspace B, though the user belongs to both", async () => {
    const seen = await run({ userId: u3, workspaceId: wsA }, async (r) => ({
      a: await r.workspaces.findById(wsA),
      b: await r.workspaces.findById(wsB),
      membershipB: await r.workspaces.findMembership(wsB, u3),
      listed: await r.workspaces.listForUser(u3),
    }));
    expect(seen.a?.id).toBe(wsA);
    expect(seen.b).toBeNull();
    expect(seen.membershipB).toBeNull();
    expect(seen.listed.map((w) => w.id)).toEqual([wsA]);
  });

  it("lists only the user's own workspaces without a workspace in context", async () => {
    const list = (userId: UserId, asking: UserId) =>
      run({ userId }, (r) => r.workspaces.listForUser(asking)).then((ws) =>
        ws.map((w) => w.id).toSorted(),
      );
    expect(await list(u1, u1)).toEqual([wsA]);
    expect(await list(u3, u3)).toEqual([wsA, wsB].toSorted());
    expect(await list(u1, u3)).toEqual([]);
  });

  it("returns the caller's own role in each listed workspace", async () => {
    const roles = (userId: UserId) =>
      run({ userId }, (r) => r.workspaces.listForUser(userId)).then((ws) =>
        Object.fromEntries(ws.map((w) => [w.id, w.role])),
      );
    expect(await roles(u1)).toEqual({ [wsA]: "owner" });
    expect(await roles(u3)).toEqual({ [wsA]: "member", [wsB]: "member" });
  });

  it("returns the caller's own membership with its role", async () => {
    const m = await run({ userId: u3, workspaceId: wsA }, (r) =>
      r.workspaces.findMembership(wsA, u3),
    );
    expect(m).toEqual({ workspaceId: wsA, userId: u3, role: "member" });
  });
});

describe("the workspace id is a claim, not proof", () => {
  it("refuses a context naming a workspace the user does not belong to", async () => {
    await expect(run({ userId: u1, workspaceId: wsB }, async () => "ran")).rejects.toBeInstanceOf(
      WorkspaceAccessDenied,
    );
  });

  it("refuses a workspace that does not exist the same way", async () => {
    const ghost = parseWorkspaceId(randomUUID());
    await expect(run({ userId: u1, workspaceId: ghost }, async () => "ran")).rejects.toBeInstanceOf(
      WorkspaceAccessDenied,
    );
  });

  it("denies self-adding to another workspace, with or without a context", async () => {
    const attempt = (workspaceId?: WorkspaceId) =>
      run(workspaceId === undefined ? { userId: u1 } : { userId: u1, workspaceId: wsA }, (r) =>
        r.workspaces.addMember(wsB, u1, "owner"),
      );
    await expect(attempt()).rejects.toBeInstanceOf(WorkspaceAccessDenied);
    await expect(attempt(wsA)).rejects.toBeInstanceOf(WorkspaceAccessDenied);
  });

  it("denies a member from adding anyone, even in their own workspace", async () => {
    await expect(
      run({ userId: u3, workspaceId: wsA }, (r) => r.workspaces.addMember(wsA, u2, "member")),
    ).rejects.toBeInstanceOf(WorkspaceAccessDenied);
  });

  it("lets an admin add members but not owners", async () => {
    const admin = await fx.seedUser();
    const target = await fx.seedUser();
    await run({ userId: u1, workspaceId: wsA }, (r) => r.workspaces.addMember(wsA, admin, "admin"));
    const asAdmin = { userId: admin, workspaceId: wsA };
    await expect(
      run(asAdmin, (r) => r.workspaces.addMember(wsA, target, "member")),
    ).resolves.toBeDefined();
    await expect(
      run(asAdmin, (r) => r.workspaces.addMember(wsA, u2, "owner")),
    ).rejects.toBeInstanceOf(WorkspaceAccessDenied);
  });

  it("denies creating a workspace owned by someone else", async () => {
    const id = parseWorkspaceId(randomUUID());
    await expect(
      run({ userId: u1 }, (r) => r.workspaces.insert({ id, name: "x" }, u2)),
    ).rejects.toBeInstanceOf(WorkspaceAccessDenied);
  });
});

describe("with missing or forged context the database returns nothing", () => {
  const contexts: [string, () => { userId?: string; workspaceId?: string } | null][] = [
    ["no settings at all", () => null],
    ["empty settings", () => ({})],
    ["a workspace id without a user", () => ({ workspaceId: wsA })],
    ["a non-member user naming the workspace", () => ({ userId: randomUUID(), workspaceId: wsA })],
  ];

  it.each(contexts)("%s", async (_name, context) => {
    for (const table of ["workspaces", "memberships", "users"]) {
      expect(await fx.queryAs(context(), `select * from ${table}`), table).toHaveLength(0);
    }
  });

  it("rejects inserts without a user context", async () => {
    const id = randomUUID();
    expect(
      await sqlState(
        fx.queryAs(null, "insert into workspaces (id, name, created_by) values ($1, 'x', $2)", [
          id,
          u1,
        ]),
      ),
    ).toBe("42501");
    expect(
      await sqlState(
        fx.queryAs(
          null,
          "insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')",
          [wsA, u1],
        ),
      ),
    ).toBe("42501");
  });

  it("shows a user only their own row in users", async () => {
    const rows = await fx.queryAs<{ id: string }>({ userId: u1 }, "select id from users");
    expect(rows.map((r) => r.id)).toEqual([u1]);
  });
});

describe("database constraints", () => {
  it("rejects a duplicate membership and an unknown user", async () => {
    const asOwner = { userId: u1, workspaceId: wsA };
    await expect(
      run(asOwner, (r) => r.workspaces.addMember(wsA, u3, "admin")),
    ).rejects.toBeInstanceOf(AlreadyMember);
    await expect(
      run(asOwner, (r) => r.workspaces.addMember(wsA, parseUserId(randomUUID()), "member")),
    ).rejects.toBeInstanceOf(UnknownUser);
  });

  const violations: [string, string, () => unknown[], string][] = [
    [
      "a role outside owner/admin/member",
      "insert into memberships (workspace_id, user_id, role) values ($1, $2, 'root')",
      () => [wsA, u2],
      "23514",
    ],
    [
      "a mixed-case email",
      "insert into users (id, email) values (gen_random_uuid(), 'Mixed@Test.invalid')",
      () => [],
      "23514",
    ],
    [
      "an empty workspace name",
      "insert into workspaces (id, name, created_by) values (gen_random_uuid(), '', $1)",
      () => [u1],
      "23514",
    ],
    [
      "a duplicate email",
      "insert into users (id, email) select gen_random_uuid(), email from users where id = $1",
      () => [u1],
      "23505",
    ],
  ];

  it.each(violations)("rejects %s", async (_name, statement, values, code) => {
    expect(await sqlState(fx.owner.query(statement, values()))).toBe(code);
  });
});
