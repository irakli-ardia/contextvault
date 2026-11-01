import type { DocumentVersionId } from "../kernel/ids";
import { fakeIngestion, workspaceId } from "./fakes";
import { isRunning } from "./lifecycle";
import type { RecoveryRepository, RecoverySource, RecoveryUnitOfWork } from "./recovery-ports";

/**
 * Recovery ports over `fakeIngestion`: the same maps, so its unit of work already rolls versions
 * and outbox back when the work throws. `beat` stamps a version's last heartbeat, for its current generation, on the shared clock.
 */
export function fakeRecovery() {
  const base = fakeIngestion();
  const beats = new Map<string, { at: Date; generation: number }>();
  // A beat counts only for the generation it was stamped under, as a fenced heartbeat would.
  const expired = (id: string, durationMs: number) => {
    const beat = beats.get(id);
    return (
      beat !== undefined &&
      beat.generation === base.versions.get(id)?.leaseGeneration &&
      base.clock.now.getTime() - beat.at.getTime() >= durationMs
    );
  };

  const recovery: RecoveryRepository = {
    expireLease: async ({ versionId: id, observedGeneration, leaseDurationMs }) => {
      const row = base.versions.get(id);
      if (!row || !isRunning(row.status) || row.leaseGeneration !== observedGeneration) return null;
      if (!expired(id, leaseDurationMs)) return null;
      const leaseGeneration = row.leaseGeneration + 1;
      base.versions.set(id, { ...row, leaseGeneration });
      return { status: row.status, attempt: row.attempt, leaseGeneration };
    },
  };
  const recoverySource: RecoverySource = {
    listExpiredLeases: async (limit, leaseDurationMs) =>
      [...base.versions.values()]
        .filter((v) => isRunning(v.status) && expired(v.id, leaseDurationMs))
        .slice(0, limit)
        .map((v) => ({ workspaceId, versionId: v.id, observedGeneration: v.leaseGeneration })),
  };
  const uow: RecoveryUnitOfWork = {
    run: (context, work, options) =>
      base.uow.run(context, ({ ingestion }) => work({ ingestion, recovery }), options),
  };

  return {
    ...base,
    recoverySource,
    uow,
    beat: (id: DocumentVersionId) =>
      beats.set(id, {
        at: base.clock.now,
        generation: base.versions.get(id)?.leaseGeneration ?? 0,
      }),
  };
}
