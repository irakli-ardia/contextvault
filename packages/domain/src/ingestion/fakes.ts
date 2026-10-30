import type { VersionStatus } from "../documents/document";
import { TransactionOutcomeUnknown } from "../kernel/errors";
import {
  type DocumentVersionId,
  parseDocumentVersionId,
  parseOutboxId,
  parseWorkspaceId,
} from "../kernel/ids";
import { canTransition, type IngestionFailure, isRunning, maxAttempts } from "./lifecycle";
import type {
  IngestionRepository,
  IngestionUnitOfWork,
  IngestionVersion,
  JobQueue,
  OutboxCursor,
  OutboxEntry,
  OutboxSource,
} from "./ports";

// Deterministic ids keep this file free of node:crypto, which the domain must not import.
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
export const workspaceId = parseWorkspaceId(uuid(1));
export const versionId = (n: number): DocumentVersionId => parseDocumentVersionId(uuid(1000 + n));

// Fixed-width time first, so string order is the `(available_at, id)` order of the real source.
const cursorOf = (availableAt: Date, id: string): OutboxCursor =>
  `${availableAt.getTime().toString().padStart(15, "0")}|${id}`;

interface OutboxRow {
  readonly entry: OutboxEntry;
  dispatchedAt: Date | null;
}
interface VersionRow extends IngestionVersion {
  failure?: IngestionFailure;
}

// In-memory ports for ingestion tests. The unit of work rolls state back when the work throws, the
// queue holds one job per id for good like BullMQ's default retention of finished jobs (an add of a
// held id is a silent no-op), and the queue refuses calls made inside a transaction. `clock` stands
// in for the database clock: every schedule is relative to it and only `advance` moves it.
export function fakeIngestion() {
  const clock = { now: new Date("2026-10-30T12:00:00Z") };
  const versions = new Map<string, VersionRow>();
  const outbox = new Map<string, OutboxRow>();
  const jobs = new Map<string, { workspaceId: string; versionId: string }>();
  const faults = {
    enqueue: false,
    listDue: false,
    transition: false,
    listDispatched: false,
    insertOutbox: false,
    /** Another worker claims the version between the read and the write. */
    claimedMeanwhile: false,
    /** The commit succeeds but the acknowledgement is lost. */
    lostAck: false,
  };
  /** Versions whose enqueue always fails, while the queue works for the rest. */
  const poisoned = new Set<string>();
  const log: string[] = [];
  let open = false;

  const source: OutboxSource = {
    listDue: async (limit, after) => {
      if (faults.listDue) throw new Error("database unavailable");
      return [...outbox.values()]
        .filter(
          (r) => (faults.listDispatched || !r.dispatchedAt) && r.entry.availableAt <= clock.now,
        )
        .map((r) => r.entry)
        .filter((e) => after === undefined || e.cursor > after)
        .sort((a, b) => (a.cursor < b.cursor ? -1 : 1))
        .slice(0, limit);
    },
  };
  const queue: JobQueue = {
    enqueue: async (job) => {
      if (open) throw new Error("enqueue called inside a transaction");
      log.push("enqueue");
      if (faults.enqueue) throw new Error("redis unavailable");
      if (poisoned.has(job.versionId)) throw new Error("poison");
      if (!jobs.has(job.jobId)) jobs.set(job.jobId, job);
    },
  };
  const claimMeanwhile = (id: string) => {
    const row = versions.get(id);
    if (faults.claimedMeanwhile && row) {
      versions.set(id, { ...row, leaseGeneration: row.leaseGeneration + 1 });
    }
  };
  const ingestion: IngestionRepository = {
    findVersion: async (id) => versions.get(id) ?? null,
    claim: async ({ versionId: id }) => {
      const row = versions.get(id);
      const scheduled = [...outbox.values()].some(
        (r) => r.entry.versionId === id && !r.dispatchedAt && r.entry.availableAt > clock.now,
      );
      if (!row || scheduled || row.attempt >= maxAttempts) return null;
      if (row.status !== "uploaded" && row.status !== "queued") return null;
      const claimed = { leaseGeneration: row.leaseGeneration + 1, attempt: row.attempt + 1 };
      versions.set(id, { ...row, ...claimed, status: "parsing" });
      for (const r of outbox.values()) {
        if (r.entry.versionId === id && !r.dispatchedAt) r.dispatchedAt = clock.now;
      }
      return claimed;
    },
    heartbeat: async ({ versionId: id, leaseGeneration }) => {
      const row = versions.get(id);
      return row?.leaseGeneration === leaseGeneration && isRunning(row.status);
    },
    transition: async ({ versionId: id, leaseGeneration, from, to }) => {
      if (faults.transition) throw new Error("connection lost");
      claimMeanwhile(id);
      const row = versions.get(id);
      if (!row || row.status !== from || row.leaseGeneration !== leaseGeneration) return false;
      if (!canTransition(from, to)) throw new Error(`illegal transition ${from} -> ${to}`);
      versions.set(id, { ...row, status: to });
      return true;
    },
    failVersion: async ({ versionId: id, leaseGeneration, from, failure }) => {
      claimMeanwhile(id);
      const row = versions.get(id);
      if (!row || row.status !== from || row.leaseGeneration !== leaseGeneration) return false;
      if (!canTransition(from, "failed")) throw new Error(`illegal transition ${from} -> failed`);
      versions.set(id, { ...row, status: "failed", failure });
      return true;
    },
    insertOutbox: async (entry) => {
      if (faults.insertOutbox) throw new Error("connection lost");
      const live = [...outbox.values()].some(
        (r) => r.entry.versionId === entry.versionId && !r.dispatchedAt,
      );
      if (live) return;
      const { delayMs, ...rest } = entry;
      const availableAt = new Date(clock.now.getTime() + delayMs);
      const cursor = cursorOf(availableAt, entry.id);
      outbox.set(entry.id, { entry: { ...rest, availableAt, cursor }, dispatchedAt: null });
    },
    markDispatched: async (id) => {
      const row = outbox.get(id);
      if (!row || row.dispatchedAt) return false;
      row.dispatchedAt = clock.now;
      return true;
    },
  };
  const uow: IngestionUnitOfWork = {
    run: async (context, work) => {
      if (context.workspaceId !== workspaceId) throw new Error("unknown workspace");
      const saved = {
        versions: new Map(versions),
        outbox: new Map([...outbox].map(([k, r]) => [k, { ...r }])),
      };
      open = true;
      let result: Awaited<ReturnType<typeof work>>;
      try {
        result = await work({ ingestion });
      } catch (error) {
        versions.clear();
        for (const [k, v] of saved.versions) versions.set(k, v);
        outbox.clear();
        for (const [k, r] of saved.outbox) outbox.set(k, r);
        throw error;
      } finally {
        open = false;
      }
      if (faults.lostAck) throw new TransactionOutcomeUnknown();
      return result;
    },
  };

  let counter = 5000;
  return {
    source,
    queue,
    uow,
    faults,
    poisoned,
    clock,
    advance: (ms: number) => {
      clock.now = new Date(clock.now.getTime() + ms);
    },
    jobs,
    log,
    versions,
    outbox,
    newId: () => uuid(++counter),
    addVersion(n: number, status: VersionStatus, over: Partial<IngestionVersion> = {}) {
      const id = versionId(n);
      versions.set(id, { id, status, leaseGeneration: 0, attempt: 0, ...over });
      return id;
    },
    addOutbox(n: number, id: DocumentVersionId, delayMs = 0): OutboxEntry {
      const outboxId = parseOutboxId(uuid(2000 + n));
      const availableAt = new Date(clock.now.getTime() + delayMs);
      const entry = {
        id: outboxId,
        workspaceId,
        versionId: id,
        availableAt,
        cursor: cursorOf(availableAt, outboxId),
      };
      outbox.set(entry.id, { entry, dispatchedAt: null });
      return entry;
    },
  };
}
