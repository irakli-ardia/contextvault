import {
  type IngestionRepository,
  type IngestionUnitOfWork,
  parseDocumentVersionId,
  parseWorkspaceId,
  type StageInput,
  type StageRunner,
  TransactionOutcomeUnknown,
} from "@contextvault/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withHeartbeat } from "./lease-heartbeat";

const workspaceId = parseWorkspaceId("00000000-0000-4000-8000-000000000001");
const versionId = parseDocumentVersionId("00000000-0000-4000-8000-000000000002");
const secret = "postgres://user:hunter2@db/doc-body";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const input = (signal: StageInput["signal"] = new AbortController().signal): StageInput => ({
  stage: "parsing",
  workspaceId,
  versionId,
  leaseGeneration: 3,
  signal,
});
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function setup(heartbeat: IngestionRepository["heartbeat"], stage: () => Promise<void>) {
  const calls: { workspaceId: string; timeoutMs?: number | undefined; generation: number }[] = [];
  const uow: IngestionUnitOfWork = {
    run: (context, work, options) => {
      const unused = () => Promise.reject(new Error("the heartbeat touches only heartbeat"));
      const repo: IngestionRepository = {
        findVersion: unused,
        claim: unused,
        transition: unused,
        failVersion: unused,
        insertOutbox: unused,
        markDispatched: unused,
        heartbeat: (beat) => {
          calls.push({
            workspaceId: context.workspaceId,
            timeoutMs: options?.timeoutMs,
            generation: beat.leaseGeneration,
          });
          return heartbeat(beat);
        },
      };
      return work({ ingestion: repo });
    },
  };
  const onLost = vi.fn();
  const log = vi.fn();
  const inner: StageRunner = { run: stage };
  const runner = withHeartbeat(inner, {
    uow,
    intervalMs: 1_000,
    beatTimeoutMs: 5_000,
    onLost,
    log,
  });
  return { runner, calls, onLost, log };
}

describe("withHeartbeat", () => {
  it("renews the lease with the claimed generation, first one interval after the stage starts", async () => {
    const { runner, calls, onLost } = setup(
      async () => true,
      () => sleep(3_500),
    );
    const done = runner.run(input());
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2_501);
    await done;
    expect(calls).toEqual([1, 2, 3].map(() => ({ workspaceId, timeoutMs: 5_000, generation: 3 })));
    expect(onLost).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never overlaps beats: the next is armed only after the last one ends", async () => {
    let active = 0;
    let peak = 0;
    const { runner, calls } = setup(
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        await sleep(2_500);
        active -= 1;
        return true;
      },
      () => sleep(12_000),
    );
    const done = runner.run(input());
    await vi.advanceTimersByTimeAsync(15_000);
    await done;
    expect(calls.length).toBeGreaterThan(2);
    expect(peak).toBe(1);
  });

  it("reports confirmed loss once, stops beating, and leaves the stage to finish", async () => {
    const { runner, calls, onLost } = setup(
      async () => false,
      () => sleep(5_000),
    );
    const done = runner.run(input());
    await vi.advanceTimersByTimeAsync(5_000);
    await done;
    expect(calls).toHaveLength(1);
    expect(onLost).toHaveBeenCalledExactlyOnceWith({ versionId, leaseGeneration: 3 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["a transient error", () => Object.assign(new Error(secret), { code: "ECONNRESET" })],
    ["an unknown commit outcome", () => new TransactionOutcomeUnknown()],
  ])("does not treat %s as loss, logs once, and logs recovery", async (_name, error) => {
    let n = 0;
    const { runner, calls, onLost, log } = setup(
      async () => {
        n += 1;
        if (n <= 3) throw error();
        return true;
      },
      () => sleep(5_500),
    );
    const done = runner.run(input());
    await vi.advanceTimersByTimeAsync(5_500);
    await done;
    expect(calls).toHaveLength(5);
    expect(onLost).not.toHaveBeenCalled();
    expect(log.mock.calls.map(([entry]) => entry.code)).toEqual([
      "INGESTION_HEARTBEAT_FAILED",
      "INGESTION_HEARTBEAT_RECOVERED",
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toContain("hunter2");
  });

  it("awaits the beat in flight before the stage resolves, and ignores its late answer", async () => {
    let release: (owned: boolean) => void = () => undefined;
    const { runner, onLost } = setup(
      () => new Promise<boolean>((resolve) => (release = resolve)),
      () => sleep(1_500),
    );
    let finished = false;
    const done = runner.run(input()).then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(finished).toBe(false);
    release(false);
    await done;
    expect(finished).toBe(true);
    expect(onLost).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops when the stage throws, and rethrows its error", async () => {
    const failure = new Error("stage");
    const { runner, calls } = setup(
      async () => true,
      async () => {
        await sleep(1_500);
        throw failure;
      },
    );
    const done = runner.run(input()).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await done).toBe(failure);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops renewing as soon as the signal aborts, even if the stage keeps running", async () => {
    const controller = new AbortController();
    const { runner, calls, onLost } = setup(
      async () => true,
      () => sleep(10_000),
    );
    const done = runner.run(input(controller.signal));
    await vi.advanceTimersByTimeAsync(2_500);
    controller.abort();
    expect(vi.getTimerCount()).toBe(1); // the stage's own sleep only
    await vi.advanceTimersByTimeAsync(7_500);
    await done;
    expect(calls).toHaveLength(2);
    expect(onLost).not.toHaveBeenCalled();
  });

  it("does not start when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { runner, calls } = setup(
      async () => true,
      () => sleep(5_000),
    );
    const done = runner.run(input(controller.signal));
    await vi.advanceTimersByTimeAsync(5_000);
    await done;
    expect(calls).toHaveLength(0);
  });
  it("abandons a beat that never settles after beatTimeoutMs, and ignores its late answer", async () => {
    let release: (owned: boolean) => void = () => undefined;
    const { runner, onLost, log } = setup(
      () => new Promise<boolean>((resolve) => (release = resolve)),
      () => sleep(1_500),
    );
    let finished = false;
    const done = runner.run(input()).then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(1_500 + 4_999);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(vi.getTimerCount()).toBe(0);
    release(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onLost).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("drops the late failure of an abandoned beat without logging or an unhandled rejection", async () => {
    let fail: (error: Error) => void = () => undefined;
    const { runner, log } = setup(
      () => new Promise<boolean>((_resolve, reject) => (fail = reject)),
      () => sleep(1_500),
    );
    const done = runner.run(input());
    await vi.advanceTimersByTimeAsync(1_500 + 5_000);
    await done;
    fail(new Error(secret));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(log).not.toHaveBeenCalled();
  });

  it("leaves no abort listener behind after a stage completes, fails or aborts", async () => {
    const controller = new AbortController();
    const live = new Set<unknown>();
    const signal: StageInput["signal"] = {
      get aborted() {
        return controller.signal.aborted;
      },
      addEventListener: (type, listener, options) => {
        live.add(listener);
        controller.signal.addEventListener(type, listener, options);
      },
      removeEventListener: (type, listener) => {
        live.delete(listener);
        controller.signal.removeEventListener(type, listener);
      },
    };
    const outcomes = [() => sleep(10), () => Promise.reject(new Error("stage")), () => sleep(10)];
    let n = 0;
    const { runner } = setup(
      async () => true,
      () => outcomes[n++ % outcomes.length]?.() ?? Promise.resolve(),
    );
    for (let i = 0; i < 6; i += 1) {
      const done = runner.run(input(signal)).catch(() => undefined);
      if (i === 5) controller.abort();
      await vi.advanceTimersByTimeAsync(10);
      await done;
      expect(live.size).toBe(0);
    }
  });
});
