import type { VersionStatus } from "../documents/document";

export const maxAttempts = 3;
// PostgreSQL owns the schedule: the delay before the next attempt, indexed by the attempt that failed.
const retryDelaysMs: readonly number[] = [5_000, 10_000];

export type IngestionStage = "parsing" | "chunking";

/** Stable code, no document text. `retryable` is the parser's or storage's verdict, not the policy's. */
export interface IngestionFailure {
  readonly stage: IngestionStage;
  readonly code: string;
  readonly retryable: boolean;
}

export type FailureDecision =
  | { readonly action: "retry"; readonly delayMs: number }
  | { readonly action: "fail" };

// `failed` and `processed` are terminal here; the manual retry transition arrives with its
// endpoint, and `ready` with activation in M1.6.
const transitions: Readonly<Record<VersionStatus, readonly VersionStatus[]>> = {
  uploaded: ["queued", "parsing", "failed"],
  queued: ["parsing", "failed"],
  parsing: ["chunking", "queued", "failed"],
  chunking: ["processed", "queued", "failed"],
  processed: [],
  ready: [],
  failed: [],
};

export const canTransition = (from: VersionStatus, to: VersionStatus): boolean =>
  transitions[from].includes(to);

export const isRunning = (status: VersionStatus): status is IngestionStage =>
  status === "parsing" || status === "chunking";

/** `attempt` is the number of the attempt that just failed (1-based, counted at claim). */
export function decideFailure(attempt: number, retryable: boolean): FailureDecision {
  const delayMs = retryDelaysMs[attempt - 1];
  if (!retryable || attempt >= maxAttempts || delayMs === undefined) return { action: "fail" };
  return { action: "retry", delayMs };
}
