import {
  type IngestionRepository,
  type IngestionUnitOfWork,
  parseDocumentVersionId,
  StageFailure,
  type StageRunner,
  TransactionOutcomeUnknown,
} from "@contextvault/domain";
import { DelayedError } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import { handleIngestionJob, IngestionJobFailed } from "./ingestion-handler";

const ws = "00000000-0000-4000-8000-000000000001";
const version = "00000000-0000-4000-8000-000000000002";
const secret = "postgres://user:hunter2@db/doc-body";
const never = { aborted: false, addEventListener: () => undefined };

const transient = Object.assign(new Error(secret), { code: "ECONNRESET" });
const permanent = Object.assign(new Error(secret), { code: "42501" });

interface Setup {
  repo?: Partial<IngestionRepository>;
  /** An error to fail the unit of work's nth call with; `undefined` lets the call through. */
  fault?: (call: number) => Error | undefined;
  stage?: () => Promise<void>;
  moveToDelayed?: (timestamp: number, token?: string) => Promise<void>;
}

function setup(over: Setup = {}) {
  const repo: IngestionRepository = {
    findVersion: async () => ({
      id: parseDocumentVersionId(version),
      status: "parsing",
      leaseGeneration: 1,
      attempt: 1,
    }),
    claim: async () => ({ leaseGeneration: 1, attempt: 1 }),
    heartbeat: async () => true,
    transition: async () => true,
    failVersion: async () => true,
    insertOutbox: async () => undefined,
    markDispatched: async () => true,
    ...over.repo,
  };
  const real: IngestionUnitOfWork = { run: (_ctx, work) => work({ ingestion: repo }) };
  let calls = 0;
  const uow: IngestionUnitOfWork = {
    run: (ctx, work, options) => {
      calls += 1;
      const fault = over.fault?.(calls);
      return fault ? Promise.reject(fault) : real.run(ctx, work, options);
    },
  };
  const stageRun = vi.fn(over.stage ?? (async () => undefined));
  const stages: StageRunner = { run: stageRun };
  const log = vi.fn();
  const moveToDelayed = vi.fn(over.moveToDelayed ?? (async () => undefined));
  const deps = {
    uow,
    stages,
    newId: () => "00000000-0000-4000-8000-0000000000aa",
    log,
    redeliveryDelayMs: 1_000,
    signal: never,
    processJobName: "process",
  };
  const run = (data: unknown = { workspaceId: ws, versionId: version }, name = "process") =>
    handleIngestionJob(deps, { name, data, moveToDelayed }, "tok");
  return { run, stageRun, log, moveToDelayed };
}

const failsWith = async (promise: Promise<void>, code: string) => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(IngestionJobFailed);
  expect(error).toMatchObject({ code, message: code });
};

describe("handleIngestionJob", () => {
  it("processes a valid job through both stages", async () => {
    const { run, stageRun, moveToDelayed } = setup();
    await run();
    expect(stageRun).toHaveBeenCalledTimes(2);
    expect(moveToDelayed).not.toHaveBeenCalled();
  });

  it.each([
    ["a malformed payload", { workspaceId: ws }, "process"],
    ["an extra key", { workspaceId: ws, versionId: version, x: 1 }, "process"],
    ["a foreign job name", { workspaceId: ws, versionId: version }, "other"],
  ])("fails %s without touching the database", async (_n, data, name) => {
    const { run, stageRun, log } = setup({ fault: () => new Error("db touched") });
    await failsWith(run(data, name), "job.invalid_payload");
    expect(stageRun).not.toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain(ws);
  });

  it("completes a refused claim without running a stage or delaying", async () => {
    const { run, stageRun, moveToDelayed, log } = setup({ repo: { claim: async () => null } });
    await run();
    expect(stageRun).not.toHaveBeenCalled();
    expect(moveToDelayed).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ outcome: "refused" }));
  });

  it("completes the job when a retry is already scheduled in PostgreSQL", async () => {
    const { run, moveToDelayed, log } = setup({
      stage: () => Promise.reject(new StageFailure("storage.unavailable", true)),
    });
    await run();
    expect(moveToDelayed).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "retry", failure: "storage.unavailable" }),
    );
  });

  it("completes the job when the version failed or ownership moved", async () => {
    const failed = setup({ stage: () => Promise.reject(new StageFailure("parse.corrupt", false)) });
    await failed.run();
    expect(failed.log).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
    const stale = setup({ repo: { transition: async () => false } });
    await stale.run();
    expect(stale.log).toHaveBeenCalledWith(expect.objectContaining({ outcome: "stale" }));
  });

  it("delays a transient failure before the claim, with the job's token, and never fails it", async () => {
    const { run, moveToDelayed, stageRun, log } = setup({ fault: () => transient });
    const before = Date.now();
    await expect(run()).rejects.toBeInstanceOf(DelayedError);
    expect(stageRun).not.toHaveBeenCalled();
    const [at, token] = moveToDelayed.mock.calls[0] ?? [];
    expect(token).toBe("tok");
    expect(at).toBeGreaterThanOrEqual(before + 1_000);
    expect(JSON.stringify(log.mock.calls)).not.toContain("hunter2");
  });

  it("fails a permanent database error before the claim and leaks no message", async () => {
    const { run, moveToDelayed, log } = setup({ fault: () => permanent });
    await failsWith(run(), "db.permanent_error");
    expect(moveToDelayed).not.toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain("hunter2");
  });

  it("fails an ambiguous claim without delaying, running a stage, or assuming it landed", async () => {
    const { run, moveToDelayed, stageRun } = setup({
      fault: () => new TransactionOutcomeUnknown(),
    });
    await failsWith(run(), "claim.outcome_unknown");
    expect(moveToDelayed).not.toHaveBeenCalled();
    expect(stageRun).not.toHaveBeenCalled();
  });

  it("never delays once the claim resolved, even for a transient error", async () => {
    const { run, moveToDelayed } = setup({
      fault: (call) => (call === 1 ? undefined : transient),
    });
    await failsWith(run(), "ingestion.post_claim_error");
    expect(moveToDelayed).not.toHaveBeenCalled();
  });

  it("fails the job if the delay itself cannot be written", async () => {
    const { run } = setup({
      fault: () => transient,
      moveToDelayed: () => Promise.reject(new Error(secret)),
    });
    await failsWith(run(), "redelivery.failed");
  });
});
