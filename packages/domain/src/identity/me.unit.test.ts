import { describe, expect, it } from "vitest";
import type { UnitOfWork } from "../kernel/unit-of-work";
import type { WorkspaceRepository } from "../workspaces/ports";
import { Unauthenticated } from "./errors";
import { user } from "./fakes";
import { getProfile } from "./me";
import type { User, UserRepository } from "./ports";

const unused = () => Promise.reject(new Error("not used"));
const workspaces: WorkspaceRepository = {
  insert: unused,
  findById: unused,
  findMembership: unused,
  addMember: unused,
  listForUser: async () => [],
};

const uow = (
  found: User | null,
): UnitOfWork<{ users: UserRepository; workspaces: WorkspaceRepository }> => ({
  run: (_context, work) => work({ users: { findById: async () => found }, workspaces }),
});

describe("getProfile", () => {
  it("returns the user with their workspaces", async () => {
    await expect(getProfile(uow(user), user.id)).resolves.toEqual({ user, workspaces: [] });
  });

  it("treats a session whose user is not visible as signed out", async () => {
    await expect(getProfile(uow(null), user.id)).rejects.toBeInstanceOf(Unauthenticated);
  });
});
