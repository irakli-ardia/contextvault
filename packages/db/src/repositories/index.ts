import type {
  DocumentDeletionRepository,
  DocumentRepository,
  DocumentRetryRepository,
  SearchRepository,
  UploadRepository,
  UserRepository,
  WorkspaceRepository,
} from "@contextvault/domain";
import type { Executor } from "../client";
import { createDocumentDeletionRepository } from "./documents/document-deletion";
import { createDocumentRepository } from "./documents/document-repository";
import { createDocumentRetryRepository } from "./documents/document-retry";
import { createUploadRepository } from "./documents/upload-repository";
import { createSearchRepository } from "./retrieval/search-repository";
import { createUserRepository } from "./users/user-repository";
import { createWorkspaceRepository } from "./workspaces/workspace-repository";

export interface Repositories {
  readonly users: UserRepository;
  readonly workspaces: WorkspaceRepository;
  readonly documents: DocumentRepository;
  readonly documentDeletion: DocumentDeletionRepository;
  readonly documentRetry: DocumentRetryRepository;
  readonly uploads: UploadRepository;
  readonly search: SearchRepository;
}

export function createRepositories(executor: Executor): Repositories {
  return {
    users: createUserRepository(executor),
    workspaces: createWorkspaceRepository(executor),
    documents: createDocumentRepository(executor),
    documentDeletion: createDocumentDeletionRepository(executor),
    documentRetry: createDocumentRetryRepository(executor),
    uploads: createUploadRepository(executor),
    search: createSearchRepository(executor),
  };
}
