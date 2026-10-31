import type { IngestionRepository, IngestionUnitOfWork, StageInput } from "@contextvault/domain";
import { DelayedError } from "bullmq";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IngestionShutdownIncomplete } from "./consumer-shutdown";
import { createIngestionConsumer, type IngestionConsumer } from "./ingestion-consumer";

// BullMQ's Worker is replaced by a fake that keeps the one property that matters here: its first
// close() is memoized and settles only when no delivery is in flight (and a test lets it).
const h = vi.hoisted(() => {
  class FakeWorker {
    static last: FakeWorker | undefined;
    active = 0;
    closeCalls = 0;
    disconnects = 0;
    hangClose = false;
    failClose: Error | undefined;
    private closing: Promise<void> | undefined;
    private release: (() => void) | undefined;
    constructor(
      readonly name: string,
      readonly processor: (job: unknown, token: string) => Promise<void>,
    ) {
      FakeWorker.last = this;
    }
    on() {
      return this;
    }
    waitUntilReady() {
      return Promise.resolve();
    }
    async deliver(job: unknown): Promise<void> {
      this.active += 1;
      try {
        await this.processor(job, "tok");
      } finally {
        this.active -= 1;
        this.settle();
      }
    }
    close() {
      this.closeCalls += 1;
      const failure = this.failClose;
      this.closing ??= failure
        ? Promise.reject(failure)
        : new Promise<void>((resolve) => {
            this.release = resolve;
          });
      this.settle();
      return this.closing;
    }
    disconnect() {
      this.disconnects += 1;
      return Promise.resolve();
    }
    private settle() {
      if (this.closing && this.active === 0 && !this.hangClose) this.release?.();
    }
  }
  return { FakeWorker, closeConsumer: vi.fn<(redis: unknown, ms: number) => Promise<void>>() };
});

vi.mock("bullmq", async (original) => ({
  ...(await original<typeof import("bullmq")>()),
  Worker: h.FakeWorker,
}));
vi.mock("./consumer-connection", () => ({
  connectConsumer: async () => ({}),
  closeConsumer: h.closeConsumer,
}));

const ws = "00000000-0000-4000-8000-000000000001";
const a = "00000000-0000-4000-8000-0000000000a1";
const b = "00000000-0000-4000-8000-0000000000b2";
const drain = 2_000;
const grace = 1_000;
const release = 500;

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => void unhandled.push(reason);

beforeEach(() => {
  vi.useFakeTimers();
  h.closeConsumer.mockResolvedValue(undefined);
  process.on("unhandledRejection", onUnhandled);
});
afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
  vi.useRealTimers();
});

const deferred = () => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const untilAborted = (input: StageInput) =>
  new Promise<void>((_resolve, reject) =>
    input.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
  );

async function setup(stage: (input: StageInput) => Promise<void>) {
  const transitions: string[] = [];
  const claims: string[] = [];
  const signals: StageInput["signal"][] = [];
  const unused = () => Promise.reject(new Error("unused"));
  const repo: IngestionRepository = {
    findVersion: unused,
    claim: async ({ versionId }) => {
      claims.push(versionId);
      return { leaseGeneration: 1, attempt: 1 };
    },
    heartbeat: async () => true,
    transition: async ({ versionId, to }) => {
      transitions.push(`${versionId}:${to}`);
      return true;
    },
    failVersion: async () => true,
    insertOutbox: async () => undefined,
    markDispatched: async () => true,
  };
  const uow: IngestionUnitOfWork = { run: (_ctx, work) => work({ ingestion: repo }) };
  const log = vi.fn<(entry: Record<string, unknown>) => void>();
  const consumer: IngestionConsumer = await createIngestionConsumer({
    redisUrl: "redis://unused",
    uow,
    stages: {
      run: (input) => {
        signals.push(input.signal);
        return stage(input);
      },
    },
    newId: () => "00000000-0000-4000-8000-0000000000aa",
    log,
    heartbeatIntervalMs: 1_000,
    drainTimeoutMs: drain,
    cancelGraceMs: grace,
    releaseTimeoutMs: release,
  });
  const worker = h.FakeWorker.last;
  if (!worker) throw new Error("no worker");
  const moveToDelayed = vi.fn(async () => undefined);
  const deliver = (versionId: string) =>
    worker.deliver({ name: "process", data: { workspaceId: ws, versionId }, moveToDelayed });
  const codes = () => log.mock.calls.map(([{ code }]) => code);
  // Observed from the start, so a rejection that settles before the test awaits it is not unhandled.
  const outcome = (closing: Promise<void>) =>
    closing.then(
      () => "closed",
      (error: unknown) => error,
    );
  return {
    consumer,
    worker,
    deliver,
    moveToDelayed,
    transitions,
    claims,
    signals,
    log,
    codes,
    outcome,
  };
}

describe("ingestion consumer shutdown", () => {
  it("closes at once with no job in flight and leaves no timer", async () => {
    const t = await setup(async () => undefined);
    await t.consumer.close();
    expect(t.worker.closeCalls).toBe(1);
    expect(t.worker.disconnects).toBe(0);
    expect(h.closeConsumer).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets a job that finishes inside the drain deadline complete untouched", async () => {
    const gate = deferred();
    const t = await setup(() => gate.promise);
    const job = t.deliver(a);
    await vi.advanceTimersByTimeAsync(0);
    const closing = t.outcome(t.consumer.close());
    await vi.advanceTimersByTimeAsync(drain - 500);
    gate.resolve();
    await job;
    expect(await closing).toBe("closed");
    expect(t.signals[0]?.aborted).toBe(false);
    expect(t.transitions).toEqual([`${a}:chunking`, `${a}:processed`]);
    expect(t.codes()).not.toContain("INGESTION_SHUTDOWN_CANCELLING");
    expect(t.worker.disconnects).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a cooperative job after the drain deadline without claiming a lost lease", async () => {
    const t = await setup(untilAborted);
    const job = t.deliver(a);
    await vi.advanceTimersByTimeAsync(0);
    const closing = t.outcome(t.consumer.close());
    await vi.advanceTimersByTimeAsync(drain - 1);
    expect(t.signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await job;
    expect(await closing).toBe("closed");
    expect(t.signals[0]?.aborted).toBe(true);
    expect(t.codes()).toContain("INGESTION_SHUTDOWN_CANCELLING");
    expect(t.codes()).not.toContain("INGESTION_LEASE_LOST");
    expect(t.log).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "aborted", shutdownCancelled: true }),
    );
    expect(t.transitions).toEqual([]);
    expect(t.worker.disconnects).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels every job in flight, each through its own signal", async () => {
    const t = await setup(untilAborted);
    const jobs = [t.deliver(a), t.deliver(b)];
    await vi.advanceTimersByTimeAsync(0);
    const closing = t.outcome(t.consumer.close());
    await vi.advanceTimersByTimeAsync(drain);
    await Promise.all(jobs);
    expect(await closing).toBe("closed");
    expect(t.signals.map((signal) => signal.aborted)).toEqual([true, true]);
    expect(t.signals[0]).not.toBe(t.signals[1]);
  });

  it("reports a stage that ignores cancellation, forces the connections and writes nothing later", async () => {
    const gate = deferred();
    const t = await setup(() => gate.promise);
    const job = t.deliver(a);
    await vi.advanceTimersByTimeAsync(0);
    const closing = t.outcome(t.consumer.close());
    await vi.advanceTimersByTimeAsync(drain + grace);
    const error = await closing;
    expect(error).toBeInstanceOf(IngestionShutdownIncomplete);
    expect(error).toMatchObject({ abandonedJobs: 1 });
    expect(t.worker.disconnects).toBe(1);
    expect(h.closeConsumer).toHaveBeenCalledTimes(1);
    expect(t.codes()).toContain("INGESTION_SHUTDOWN_INCOMPLETE");
    // The stage is still running. Once it returns, the cancelled job writes nothing.
    gate.resolve();
    await job;
    expect(t.transitions).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns one outcome to concurrent and repeated calls and closes once", async () => {
    const t = await setup(async () => undefined);
    const first = t.consumer.close();
    const second = t.consumer.close();
    expect(second).toBe(first);
    await first;
    expect(t.consumer.close()).toBe(first);
    await t.consumer.close();
    expect(t.worker.closeCalls).toBe(1);
    expect(h.closeConsumer).toHaveBeenCalledTimes(1);

    const gate = deferred();
    const stuck = await setup(() => gate.promise);
    const job = stuck.deliver(a);
    await vi.advanceTimersByTimeAsync(0);
    const failing = stuck.outcome(stuck.consumer.close());
    const again = stuck.outcome(stuck.consumer.close());
    await vi.advanceTimersByTimeAsync(drain + grace);
    expect(await again).toBeInstanceOf(IngestionShutdownIncomplete);
    expect(await failing).toBe(await again);
    expect(await stuck.outcome(stuck.consumer.close())).toBe(await again);
    gate.resolve();
    await job;
  });

  it("bounds a Redis release that never settles and still releases the sockets", async () => {
    const t = await setup(async () => undefined);
    t.worker.hangClose = true;
    const closing = t.outcome(t.consumer.close());
    await vi.advanceTimersByTimeAsync(release);
    expect(await closing).toBe("closed");
    expect(t.worker.disconnects).toBe(1);
    expect(h.closeConsumer).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still releases the connection when closing the worker fails, and reports it", async () => {
    const t = await setup(async () => undefined);
    const failure = new Error("secret-host:6379");
    t.worker.failClose = failure;
    expect(await t.outcome(t.consumer.close())).toMatchObject({ cause: failure });
    expect(h.closeConsumer).toHaveBeenCalledTimes(1);
    expect(t.codes()).toContain("CONSUMER_CLOSE_FAILED");
    expect(JSON.stringify(t.log.mock.calls)).not.toContain("secret-host");
  });

  it("offers a job BullMQ hands over after close began again, claiming nothing", async () => {
    const stage = vi.fn(async () => undefined);
    const t = await setup(stage);
    t.worker.hangClose = true;
    const closing = t.outcome(t.consumer.close());
    await expect(t.deliver(a)).rejects.toBeInstanceOf(DelayedError);
    expect(t.moveToDelayed).toHaveBeenCalledTimes(1);
    expect(t.claims).toEqual([]);
    expect(stage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(release);
    await closing;
  });

  it("raises no unhandled rejection through any of the paths above", async () => {
    const gate = deferred();
    const t = await setup(() => gate.promise);
    const job = t.deliver(a);
    await vi.advanceTimersByTimeAsync(0);
    const closing = t.outcome(t.consumer.close());
    await vi.advanceTimersByTimeAsync(drain + grace);
    await closing;
    gate.resolve();
    await job;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(unhandled).toEqual([]);
  });
});
