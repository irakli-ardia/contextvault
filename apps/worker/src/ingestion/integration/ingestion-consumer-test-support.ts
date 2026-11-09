import {
  type IngestionUnitOfWork,
  StageFailure,
  type StageInput,
  type StageRunner,
  TransactionOutcomeUnknown,
} from "@contextvault/domain";

/** Fake stages: records `<version>:<stage>` per run and lets a test script the behaviour. */
export function recordingStages(behaviour: (input: StageInput) => Promise<void> | void = () => {}) {
  const calls: string[] = [];
  const stages: StageRunner = {
    run: async (input) => {
      calls.push(`${input.versionId}:${input.stage}`);
      await behaviour(input);
    },
  };
  return { stages, calls, of: (versionId: string) => calls.filter((c) => c.startsWith(versionId)) };
}

export const failStage =
  (stage: string, code: string, retryable: boolean) => (input: StageInput) => {
    if (input.stage === stage) throw new StageFailure(code, retryable);
  };

export type Fault = "transient" | "permanent" | "ambiguous-after-commit";

/**
 * Wraps the real unit of work and fails the nth call (1-based, every consumer of this wrapper
 * counts together) with a scripted database fault; other calls pass through to PostgreSQL.
 * An ambiguous fault runs the work for real first, so the claim lands but its acknowledgement is lost.
 */
export function faultyUow(real: IngestionUnitOfWork, plan: (call: number) => Fault | undefined) {
  let calls = 0;
  const uow: IngestionUnitOfWork = {
    run: (context, work, options) => {
      calls += 1;
      const fault = plan(calls);
      if (fault === "transient") {
        return Promise.reject(Object.assign(new Error("secret-host:5432"), { code: "ECONNRESET" }));
      }
      if (fault === "permanent") {
        return Promise.reject(Object.assign(new Error("secret-sql"), { code: "42501" }));
      }
      const done = real.run(context, work, options);
      return fault === "ambiguous-after-commit"
        ? done.then(() => Promise.reject(new TransactionOutcomeUnknown()))
        : done;
    },
  };
  return { uow, calls: () => calls };
}
