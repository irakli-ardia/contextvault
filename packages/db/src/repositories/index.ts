import type {
  DocumentRepository,
  UploadRepository,
  UserRepository,
  WorkspaceRepository,
} from "@contextvault/domain";
import type { Executor } from "../client";
import { createDocumentRepository } from "./documents/document-repository";
import { createUploadRepository } from "./documents/upload-repository";
import { createUserRepository } from "./users/user-repository";
import { createWorkspaceRepository } from "./workspaces/workspace-repository";

export interface Repositories {
  readonly users: UserRepository;
  readonly workspaces: WorkspaceRepository;
  readonly documents: DocumentRepository;
  readonly uploads: UploadRepository;
}

export function createRepositories(executor: Executor): Repositories {
  return {
    users: createUserRepository(executor),
    workspaces: createWorkspaceRepository(executor),
    documents: createDocumentRepository(executor),
    uploads: createUploadRepository(executor),
  };
}
