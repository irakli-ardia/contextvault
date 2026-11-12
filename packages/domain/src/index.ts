export {
  type DeleteDocumentDeps,
  type DeleteDocumentOutcome,
  deleteDocument,
} from "./documents/delete-document";
export {
  type DocumentFailure,
  type DocumentMime,
  type DocumentSummary,
  documentMimes,
  isDocumentMime,
  isVersionStatus,
  maxUploadBytes,
  type UploadQuota,
  uploadQuota,
  type VersionStatus,
  versionStatuses,
} from "./documents/document";
export {
  DocumentNotFound,
  DocumentNotRetryable,
  type InterruptionReason,
  type ReservationState,
  StorageError,
  type StorageErrorCode,
  UploadConflict,
  UploadInterrupted,
  UploadRejected,
  type UploadRejectionCode,
  UploadReservationMissing,
} from "./documents/errors";
export { sanitizeFileName } from "./documents/filename";
export type { DeadlineSignal, DocumentStore, PutOptions, StoredObject } from "./documents/ports";
export {
  createPurgeSweep,
  type PurgeBatch,
  type PurgeDocumentDeps,
  type PurgeDocumentInput,
  type PurgeDocumentOutcome,
  type PurgeSweepDeps,
  purgeDocument,
} from "./documents/purge-documents";
export {
  type PurgeCandidate,
  type PurgeCursor,
  type PurgeRepository,
  type PurgeSource,
  type PurgeUnitOfWork,
  purgePageLimit,
} from "./documents/purge-ports";
export {
  getDocument,
  listDocuments,
  maxListedDocuments,
  type ReadDocumentsDeps,
} from "./documents/read-documents";
export {
  type RetryDocumentDeps,
  retryDocument,
} from "./documents/retry-document";
export { documentObjectKey, parseStorageKey, type StorageKey } from "./documents/storage-key";
export {
  type UploadDocumentCommand,
  type UploadDocumentDeps,
  type UploadDocumentResult,
  uploadDocument,
} from "./documents/upload-document";
export type {
  DocumentDeletionRepository,
  DocumentRepository,
  DocumentRetryRepository,
  FinalizeResult,
  FinalizeUploadInput,
  PendingUpload,
  QuotaRefusal,
  ReserveResult,
  ReserveUploadInput,
  Sha256,
  UploadRepository,
  UploadServices,
} from "./documents/upload-ports";
export { type Email, parseEmail } from "./identity/email";
export { HashingBusy, InvalidCredentials, Unauthenticated } from "./identity/errors";
export { type LoginDeps, type LoginInput, login } from "./identity/login";
export { getProfile, type Profile } from "./identity/me";
export { type Password, parsePassword, passwordLength } from "./identity/password";
export type {
  CredentialStore,
  PasswordHasher,
  SessionStore,
  StoredCredential,
  User,
  UserRepository,
} from "./identity/ports";
export {
  type Identity,
  logout,
  resolveSession,
  type SessionDeps,
} from "./identity/resolve-session";
export {
  isSessionActive,
  needsTouch,
  newSession,
  type Session,
  sessionLifetime,
} from "./identity/session";
export {
  parseSessionTokenHash,
  type SessionTokenHash,
  type SessionTokens,
} from "./identity/tokens";
export type { ChunkSet, EmbeddedChunkSet, NewChunk, NewSection } from "./ingestion/chunk-set";
export {
  type DispatchFailure,
  type DispatchOutboxDeps,
  type DispatchOutboxResult,
  dispatchOutbox,
  outboxJobId,
} from "./ingestion/dispatch-outbox";
export {
  canTransition,
  decideFailure,
  type FailureDecision,
  type IngestionFailure,
  type IngestionStage,
  isRunning,
  maxAttempts,
} from "./ingestion/lifecycle";
export type {
  OrphanCandidate,
  OrphanCursor,
  OrphanRepository,
  OrphanSnapshot,
  OrphanSource,
  OrphanUnitOfWork,
} from "./ingestion/orphan-ports";
export type {
  ClaimedVersion,
  IngestionRepository,
  IngestionUnitOfWork,
  IngestionVersion,
  JobQueue,
  NewOutboxEntry,
  OutboxCursor,
  OutboxEntry,
  OutboxSource,
  WorkerContext,
  WorkerUnitOfWork,
} from "./ingestion/ports";
export {
  type ProcessVersionDeps,
  type ProcessVersionInput,
  type ProcessVersionResult,
  processVersion,
} from "./ingestion/process-version";
export {
  type ParseSourceRepository,
  type ParseSourceUnitOfWork,
  type ReadVersionBytesDeps,
  type ReadVersionBytesInput,
  readVersionBytes,
} from "./ingestion/read-version-bytes";
export {
  type RecoverExpiredLeaseDeps,
  type RecoverExpiredLeaseInput,
  type RecoverExpiredLeaseResult,
  recoverExpiredLease,
} from "./ingestion/recover-expired-lease";
export {
  leaseDurationMs,
  orphanPageLimit,
  outboxHistoryCap,
  redriveBaseCooldownMs,
  redriveCooldownMs,
  redriveMaxCooldownMs,
} from "./ingestion/recovery-policy";
export type {
  ExpiredLease,
  ExpiredLeaseCandidate,
  RecoveryRepository,
  RecoverySource,
  RecoveryUnitOfWork,
} from "./ingestion/recovery-ports";
export {
  type RedriveOrphanDeps,
  type RedriveOrphanInput,
  type RedriveOrphanResult,
  redriveOrphan,
} from "./ingestion/redrive-orphan";
export {
  type SettleFailureDeps,
  type SettleFailureInput,
  type SettleFailureResult,
  settleFailure,
} from "./ingestion/settle-failure";
export { StageFailure, type StageInput, type StageRunner } from "./ingestion/stage-runner";
export {
  fullySkipped,
  type SweepBatch,
  type SweepRecoveryDeps,
  type SweepRecoveryResult,
  sweepRecovery,
} from "./ingestion/sweep-recovery";
export { DomainError, TransactionOutcomeUnknown } from "./kernel/errors";
export {
  type DocumentId,
  type DocumentVersionId,
  type OutboxId,
  parseDocumentId,
  parseDocumentVersionId,
  parseOutboxId,
  parseSessionId,
  parseUserId,
  parseWorkspaceId,
  type SessionId,
  type UserId,
  type WorkspaceId,
} from "./kernel/ids";
export type { TenantContext, UnitOfWork, UnitOfWorkOptions } from "./kernel/unit-of-work";
export { type Embedder, EmbeddingFailure, embeddingDimensions } from "./retrieval/embedder";
export {
  InvalidSearch,
  type SearchHit,
  type SearchRepository,
  searchChunks,
} from "./retrieval/search-chunks";
export { AlreadyMember, UnknownUser, WorkspaceAccessDenied } from "./workspaces/errors";
export {
  type Action,
  type Actor,
  actions,
  assertCan,
  can,
  PermissionDenied,
} from "./workspaces/permissions";
export type { WorkspaceRepository } from "./workspaces/ports";
export { readWorkspace } from "./workspaces/read-workspace";
export { resolveActor } from "./workspaces/resolve-actor";
export {
  isRole,
  type Membership,
  type Role,
  roles,
  type Workspace,
  type WorkspaceWithRole,
} from "./workspaces/workspace";
