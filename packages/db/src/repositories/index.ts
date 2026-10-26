import type { UserRepository, WorkspaceRepository } from "@contextvault/domain";
import type { Executor } from "../client";
import { createUserRepository } from "./users/user-repository";
import { createWorkspaceRepository } from "./workspaces/workspace-repository";

export interface Repositories {
  readonly users: UserRepository;
  readonly workspaces: WorkspaceRepository;
}

export function createRepositories(executor: Executor): Repositories {
  return {
    users: createUserRepository(executor),
    workspaces: createWorkspaceRepository(executor),
  };
}
