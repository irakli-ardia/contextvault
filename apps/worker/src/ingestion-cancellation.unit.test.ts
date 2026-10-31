import { getEventListeners } from "node:events";
import {
  type IngestionRepository,
  type IngestionUnitOfWork,
  type StageInput,
  TransactionOutcomeUnknown,
} from "@contextvault/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleIngestionJob } from "./ingestion-handler";

const ws = "00000000-0000-4000-8000-000000000001";
const a = "00000000-0000-4000-8000-0000000000a1";
const b = "00000000-0000-4000-8000-0000000000b2";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const untilAborted = (input: StageInput) =>
  new Promise<void>((_resolve, reject) =>
    input.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
  );

function setup(
  heartbeat: (versionId: string, call: number) => Promise<boolean>,
  stage: (input: StageInput) => Promise<void>,
) {
  const transitions: string[] = [];
  const beats: Record<string, number> = {};
  const unused = () => Promise.reject(new Error("unused"));
  const repo: IngestionRepository = {
    findVersion: unused,
    claim: async () => ({ leaseGeneration: 1, attempt: 1 }),
    heartbeat: ({ versionId }) => {
      beats[versionId] = (beats[versionId] ?? 0) + 1;
      return heartbeat(versionId, beats[versionId] ?? 0);
    },
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
  const shutdown = new AbortController();
  const signals: Record<string, StageInput["signal"]> = {};
  const deps = {
    uow,
    stages: {
      run: (input: StageInput) => {
        signals[input.versionId] = input.signal;
        return stage(input);
      },
    },
    newId: () => "00000000-0000-4000-8000-0000000000aa",
    log,
    redeliveryDelayMs: 1_000,
    heartbeatIntervalMs: 1_000,
    heartbeatTimeoutMs: 1_000,
    processJobName: "process",
    shutdown: shutdown.signal,
  };
  const run = (versionId: string) =>
    handleIngestionJob(
      deps,
      {
        name: "process",
        data: { workspaceId: ws, versionId },
        moveToDelayed: async () => undefined,
      },
      "tok",
    );
  const codes = () => log.mock.calls.map(([{ code }]) => code);
  return { run, transitions, beats, signals, log, codes, shutdown };
}

describe("per-job cancellation", () => {
  it("cancels only the job whose lease was lost and lets the other finish", async () => {
    const t = setup(
      async (versionId) => versionId !== a,
      (input) => (input.versionId === a ? untilAborted(input) : sleep(2_500)),
    );
    const jobs = Promise.all([t.run(a), t.run(b)]);
    await vi.advanceTimersByTimeAsync(10_000);
    await jobs;
    expect(t.signals[a]?.aborted).toBe(true);
    expect(t.signals[b]?.aborted).toBe(false);
    expect(t.transitions).toEqual([`${b}:chunking`, `${b}:processed`]);
    expect(t.codes().filter((code) => code === "INGESTION_LEASE_LOST")).toHaveLength(1);
    expect(t.log).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "aborted", leaseLost: true }),
    );
    expect(t.log).toHaveBeenCalledWith(expect.objectContaining({ outcome: "processed" }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("writes nothing for a stage that ignores the signal and returns later", async () => {
    const t = setup(
      async () => false,
      () => sleep(3_500),
    );
    const job = t.run(a);
    await vi.advanceTimersByTimeAsync(10_000);
    await job;
    expect(t.beats[a]).toBe(1);
    expect(t.transitions).toEqual([]);
    expect(t.codes().filter((code) => code === "INGESTION_LEASE_LOST")).toHaveLength(1);
    expect(t.log).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "aborted", leaseLost: true }),
    );
  });

  it.each([
    ["a transient error", () => Object.assign(new Error("secret-host"), { code: "ECONNRESET" })],
    ["an unknown commit outcome", () => new TransactionOutcomeUnknown()],
  ])("does not cancel the job for %s of the heartbeat", async (_name, error) => {
    const t = setup(
      async (_versionId, call) => {
        if (call <= 2) throw error();
        return true;
      },
      () => sleep(2_500),
    );
    const job = t.run(a);
    await vi.advanceTimersByTimeAsync(10_000);
    await job;
    expect(t.signals[a]?.aborted).toBe(false);
    expect(t.transitions).toEqual([`${a}:chunking`, `${a}:processed`]);
    expect(t.codes()).not.toContain("INGESTION_LEASE_LOST");
    expect(JSON.stringify(t.log.mock.calls)).not.toContain("secret-host");
  });

  it("cancels on shutdown without claiming a lost lease, then stops beating and frees its listeners", async () => {
    const t = setup(async () => true, untilAborted);
    const job = t.run(a);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(t.beats[a]).toBe(1);
    t.shutdown.abort();
    await vi.advanceTimersByTimeAsync(10_000);
    await job;
    expect(t.beats[a]).toBe(1);
    expect(t.signals[a]?.aborted).toBe(true);
    expect(t.codes()).not.toContain("INGESTION_LEASE_LOST");
    expect(t.log).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "aborted", shutdownCancelled: true }),
    );
    expect(t.log).not.toHaveBeenCalledWith(expect.objectContaining({ leaseLost: true }));
    expect(t.transitions).toEqual([]);
    const signal = t.signals[a];
    if (!(signal instanceof AbortSignal)) throw new Error("stage did not get an AbortSignal");
    expect(getEventListeners(signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("logs a lost lease and a shutdown cancellation as the separate facts they are", async () => {
    const t = setup(
      async () => false,
      () => sleep(3_500),
    );
    const job = t.run(a);
    await vi.advanceTimersByTimeAsync(2_000);
    t.shutdown.abort();
    await vi.advanceTimersByTimeAsync(10_000);
    await job;
    expect(t.codes().filter((code) => code === "INGESTION_LEASE_LOST")).toHaveLength(1);
    expect(t.log).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "aborted", leaseLost: true, shutdownCancelled: true }),
    );
  });
});
