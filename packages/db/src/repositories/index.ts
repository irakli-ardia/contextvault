import type {
  DocumentDeletionRepository,
  DocumentRepository,
  UploadRepository,
  UserRepository,
  WorkspaceRepository,
} from "@contextvault/domain";
import type { Executor } from "../client";
import { createDocumentDeletionRepository } from "./documents/document-deletion";
import { createDocumentRepository } from "./documents/document-repository";
import { createUploadRepository } from "./documents/upload-repository";
import { createUserRepository } from "./users/user-repository";
import { createWorkspaceRepository } from "./workspaces/workspace-repository";

export interface Repositories {
  readonly users: UserRepository;
  readonly workspaces: WorkspaceRepository;
  readonly documents: DocumentRepository;
  readonly documentDeletion: DocumentDeletionRepository;
  readonly uploads: UploadRepository;
}

export function createRepositories(executor: Executor): Repositories {
  return {
    users: createUserRepository(executor),
    workspaces: createWorkspaceRepository(executor),
    documents: createDocumentRepository(executor),
    documentDeletion: createDocumentDeletionRepository(executor),
    uploads: createUploadRepository(executor),
  };
}
