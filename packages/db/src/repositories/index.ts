import type { WorkspaceRepository } from "@contextvault/domain";
import type { Executor } from "../client";
import { createWorkspaceRepository } from "./workspaces/workspace-repository";

export interface Repositories {
  readonly workspaces: WorkspaceRepository;
}

export function createRepositories(executor: Executor): Repositories {
  return { workspaces: createWorkspaceRepository(executor) };
}
