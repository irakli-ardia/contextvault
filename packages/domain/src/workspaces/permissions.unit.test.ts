import { describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId } from "../kernel/ids";
import { WorkspaceAccessDenied } from "./errors";
import { type Action, actions, assertCan, can, PermissionDenied } from "./permissions";
import { type Role, roles } from "./workspace";

const expected: Record<Action, Record<Role, boolean>> = {
  "workspace.read": { owner: true, admin: true, member: true },
};
const workspaceId = parseWorkspaceId("0b1c9d3e-5a7f-4c2d-8e1f-3a4b5c6d7e8f");
const otherWorkspaceId = parseWorkspaceId("2b1c9d3e-5a7f-4c2d-8e1f-3a4b5c6d7e8f");
const userId = parseUserId("1b1c9d3e-5a7f-4c2d-8e1f-3a4b5c6d7e8f");

describe("permission matrix", () => {
  it.each(actions.flatMap((action) => roles.map((role) => [action, role] as const)))(
    "%s for %s",
    (action, role) => {
      expect(can(role, action)).toBe(expected[action][role]);
      const act = () => assertCan({ userId, workspaceId, role }, action, workspaceId);
      if (expected[action][role]) expect(act).not.toThrow();
      else expect(act).toThrow(PermissionDenied);
    },
  );

  it("reports a resource of another workspace as not found", () => {
    expect(() =>
      assertCan({ userId, workspaceId, role: "owner" }, "workspace.read", otherWorkspaceId),
    ).toThrow(WorkspaceAccessDenied);
  });
});
