import type { JobQueue } from "@contextvault/domain";
import { Queue } from "bullmq";
import type { Redis } from "ioredis";

const ingestionQueueName = "ingestion";
export const processJobName = "process";

interface ProcessJobData {
  readonly workspaceId: string;
  readonly versionId: string;
}

export class EnqueueTimeout extends Error {
  override readonly name = "EnqueueTimeout";
}

// Finished jobs keep their ids so a repeated add of a delivered id stays a no-op, within these
// bounds. Past them an old id is forgotten; a repeated add then runs a job the version fence and
// the consumed outbox entry already refuse.
const retention = { removeOnComplete: { count: 1_000 }, removeOnFail: { count: 5_000 } };

/**
 * The producer half of the ingestion queue. The database, not BullMQ, retries: `attempts: 1`.
 * A timeout does not mean Redis rejected the job (it may have been added and the acknowledgement
 * lost), so it is just a failure; the caller leaves the outbox entry alone and adds again under the
 * same job id, which BullMQ answers with the job it already holds.
 */
export function createJobQueue(options: {
  connection: Redis;
  /** Tests isolate themselves on a queue of their own. */
  queueName?: string;
  enqueueTimeoutMs?: number;
}): JobQueue & { close(): Promise<void> } {
  const queue = new Queue<ProcessJobData>(options.queueName ?? ingestionQueueName, {
    connection: options.connection,
  });
  // Redis outages surface as rejected adds; the Queue's own error event must not crash the process.
  queue.on("error", () => undefined);
  const timeoutMs = options.enqueueTimeoutMs ?? 5_000;
  return {
    async enqueue({ jobId, workspaceId, versionId }) {
      const added = queue.add(
        processJobName,
        { workspaceId, versionId },
        { jobId, attempts: 1, ...retention },
      );
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new EnqueueTimeout()), timeoutMs);
      });
      try {
        await Promise.race([added, timeout]);
      } finally {
        clearTimeout(timer);
        // A late rejection of an add that already lost the race is not an unhandled one.
        added.catch(() => undefined);
      }
    },
    close: () => queue.close(),
  };
}
