import { randomUUID } from "node:crypto";
import {
  type DocumentId,
  type DocumentVersionId,
  parseOutboxId,
  type UserId,
  type WorkspaceId,
} from "@contextvault/domain";
import { type Doc, seedDoc } from "./deletion-test-support";
import type { Harness } from "./recovery-test-support";

interface FailedOptions {
  readonly retryable?: boolean | null;
  readonly attempt?: number;
  readonly code?: string;
}

/**
 * A document whose only version is `failed` as the worker leaves it: the claim already closed its
 * outbox entry, so no live entry remains. The default is a retryable failure with the attempt
 * budget spent, the case a manual retry exists for.
 */
export async function seedFailed(
  h: Harness,
  workspaceId: WorkspaceId,
  options: FailedOptions = {},
): Promise<Doc> {
  const doc = await seedDoc(h, workspaceId, "uploaded");
  const retryable = options.retryable === undefined ? true : options.retryable;
  await h.fx.fixture.query(
    `update document_versions
       set status = 'failed', attempt = $2, error_stage = 'parsing', error_code = $3,
           error_retryable = $4, lease_generation = 3
     where id = $1`,
    [doc.versionId, options.attempt ?? 3, options.code ?? "storage.unavailable", retryable],
  );
  await h.fx.fixture.query(
    "update outbox set dispatched_at = now() where version_id = $1 and dispatched_at is null",
    [doc.versionId],
  );
  return { ...doc, generation: 3 };
}

export const newOutboxId = () => parseOutboxId(randomUUID());

/** The retry command's repository step, as the application role, in the caller's transaction. */
export const retry = (
  h: Harness,
  userId: UserId,
  workspaceId: WorkspaceId,
  documentId: DocumentId,
  outboxId = newOutboxId(),
) =>
  h.fx.persistence.unitOfWork.run({ userId, workspaceId }, (r) =>
    r.documentRetry.retry(workspaceId, documentId, outboxId),
  );

export async function liveEntries(h: Harness, versionId: DocumentVersionId): Promise<number> {
  const { rows } = await h.fx.fixture.query(
    "select 1 from outbox where version_id = $1 and dispatched_at is null",
    [versionId],
  );
  return rows.length;
}
