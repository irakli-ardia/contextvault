import { describe, expect, it } from "vitest";
import type { DeadlineSignal } from "../documents/ports";
import type { DocumentVersionId } from "../kernel/ids";
import { fakeIngestion, versionId, workspaceId } from "./fakes";
import { maxAttempts } from "./lifecycle";
import { processVersion } from "./process-version";
import { StageFailure, type StageInput, type StageRunner } from "./stage-runner";

type Behaviour = (input: StageInput) => Promise<void> | void;

// This package has no AbortController typings: a signal is a flag the test flips.
const newSignal = () => {
  const signal = { aborted: false, addEventListener: () => undefined };
  return {
    signal,
    abort: () => {
      signal.aborted = true;
    },
  };
};

const setup = (behaviour: Behaviour = () => undefined) => {
  const f = fakeIngestion();
  const ran: string[] = [];
  const stages: StageRunner = {
    run: async (input) => {
      ran.push(input.stage);
      // The fake queue refuses calls made inside a transaction.
      await f.queue.enqueue({
        jobId: `probe-${input.stage}`,
        workspaceId,
        versionId: input.versionId,
      });
      await behaviour(input);
    },
  };
  const run = (id: DocumentVersionId, signal: DeadlineSignal = newSignal().signal) =>
    processVersion({ uow: f.uow, newId: f.newId, stages }, { workspaceId, versionId: id, signal });
  return { f, ran, run };
};

describe("processVersion claim", () => {
  it("runs both stages outside transactions and ends processed", async () => {
    const { f, ran, run } = setup();
    const id = f.addVersion(1, "queued");

    expect(await run(id)).toEqual({ outcome: "processed" });
    expect(ran).toEqual(["parsing", "chunking"]);
    expect(f.versions.get(id)).toMatchObject({
      status: "processed",
      attempt: 1,
      leaseGeneration: 1,
    });
  });

  it("passes the claimed generation to the runner", async () => {
    const seen: number[] = [];
    const { f, run } = setup((i) => void seen.push(i.leaseGeneration));
    await run(f.addVersion(1, "uploaded", { leaseGeneration: 4 }));
    expect(seen).toEqual([5, 5]);
  });

  it.each([
    ["not claimable", () => ({ status: "processed" as const })],
    ["attempts spent", () => ({ status: "queued" as const, attempt: maxAttempts })],
  ])("refuses a version that is %s without running a stage", async (_name, over) => {
    const { f, ran, run } = setup();
    const id = f.addVersion(1, over().status, over());

    expect(await run(id)).toEqual({ outcome: "refused" });
    expect(ran).toEqual([]);
  });

  it("refuses an early redelivery while the retry is still scheduled", async () => {
    const { f, ran, run } = setup();
    const id = f.addVersion(1, "queued");
    f.addOutbox(1, id, 5_000);

    expect(await run(id)).toEqual({ outcome: "refused" });
    expect(ran).toEqual([]);
  });

  it("refuses an unknown version", async () => {
    const { run } = setup();
    expect(await run(versionId(99))).toEqual({ outcome: "refused" });
  });
});

describe("processVersion failures", () => {
  it("requeues a retryable failure with the stage and PostgreSQL's backoff", async () => {
    const { f, run } = setup(() => {
      throw new StageFailure("storage.unavailable", true);
    });
    const id = f.addVersion(1, "queued");

    expect(await run(id)).toEqual({
      outcome: "retry",
      failure: { stage: "parsing", code: "storage.unavailable", retryable: true },
      delayMs: 5_000,
    });
    expect(f.versions.get(id)?.status).toBe("queued");
    expect(f.outbox.size).toBe(1);
  });

  it("fails a permanent failure in the chunking stage without a retry", async () => {
    const { f, run } = setup((i) => {
      if (i.stage === "chunking") throw new StageFailure("chunk.too_large", false);
    });
    const id = f.addVersion(1, "queued");

    expect(await run(id)).toEqual({
      outcome: "failed",
      failure: { stage: "chunking", code: "chunk.too_large", retryable: false },
    });
    expect(f.versions.get(id)?.status).toBe("failed");
    expect(f.outbox.size).toBe(0);
  });

  it("fails a retryable failure once attempts are exhausted", async () => {
    const { f, run } = setup(() => {
      throw new StageFailure("storage.unavailable", true);
    });
    const id = f.addVersion(1, "queued", { attempt: maxAttempts - 1 });

    expect(await run(id)).toMatchObject({ outcome: "failed" });
    expect(f.versions.get(id)).toMatchObject({ status: "failed", attempt: maxAttempts });
  });

  it("classifies an unknown exception without its message", async () => {
    const { f, run } = setup(() => {
      throw new Error("password=hunter2 in document body");
    });
    const id = f.addVersion(1, "queued");

    const result = await run(id);
    expect(result).toMatchObject({
      outcome: "retry",
      failure: { stage: "parsing", code: "stage.unexpected", retryable: true },
    });
    expect(JSON.stringify([result, [...f.versions.values()]])).not.toContain("hunter2");
  });
});

describe("processVersion ownership and cancellation", () => {
  it("is stale when the version is claimed again during a stage", async () => {
    const { f, ran, run } = setup((i) => {
      const row = f.versions.get(i.versionId);
      if (row) f.versions.set(i.versionId, { ...row, leaseGeneration: row.leaseGeneration + 1 });
    });
    const id = f.addVersion(1, "queued");

    expect(await run(id)).toEqual({ outcome: "stale" });
    expect(ran).toEqual(["parsing"]);
    expect(f.versions.get(id)?.status).toBe("parsing");
  });

  it("is stale, writing nothing, when ownership is lost before a failure settles", async () => {
    const { f, run } = setup((i) => {
      const row = f.versions.get(i.versionId);
      if (row) f.versions.set(i.versionId, { ...row, leaseGeneration: row.leaseGeneration + 1 });
      throw new StageFailure("storage.unavailable", true);
    });
    const id = f.addVersion(1, "queued");

    expect(await run(id)).toEqual({ outcome: "stale" });
    expect(f.outbox.size).toBe(0);
  });

  it("does not claim when already aborted", async () => {
    const { f, ran, run } = setup();
    const id = f.addVersion(1, "queued");

    expect(await run(id, { aborted: true, addEventListener: () => undefined })).toEqual({
      outcome: "aborted",
    });
    expect(ran).toEqual([]);
    expect(f.versions.get(id)).toMatchObject({ status: "queued", attempt: 0 });
  });

  it("writes nothing when aborted during a stage that throws", async () => {
    const controller = newSignal();
    const { f, run } = setup(() => {
      controller.abort();
      throw new StageFailure("storage.unavailable", true);
    });
    const id = f.addVersion(1, "queued");

    expect(await run(id, controller.signal)).toEqual({ outcome: "aborted" });
    expect(f.versions.get(id)?.status).toBe("parsing");
    expect(f.outbox.size).toBe(0);
  });

  it("does not advance when aborted as a stage completes", async () => {
    const controller = newSignal();
    const { f, ran, run } = setup(() => controller.abort());
    const id = f.addVersion(1, "queued");

    expect(await run(id, controller.signal)).toEqual({ outcome: "aborted" });
    expect(ran).toEqual(["parsing"]);
    expect(f.versions.get(id)?.status).toBe("parsing");
  });
});

describe("processVersion database errors", () => {
  it("propagates a failure-settlement error", async () => {
    const { f, run } = setup(() => {
      throw new StageFailure("storage.unavailable", true);
    });
    f.faults.insertOutbox = true;

    await expect(run(f.addVersion(1, "queued"))).rejects.toThrow("connection lost");
  });

  it("propagates a transition error", async () => {
    const { f, run } = setup();
    f.faults.transition = true;

    await expect(run(f.addVersion(1, "queued"))).rejects.toThrow("connection lost");
  });
});
