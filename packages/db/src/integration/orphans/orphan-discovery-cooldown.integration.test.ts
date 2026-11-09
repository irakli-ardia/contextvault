import {
  type DocumentVersionId,
  maxAttempts,
  type OrphanCandidate,
  orphanPageLimit,
  outboxHistoryCap,
  redriveCooldownMs,
} from "@contextvault/domain";
import { afterAll, describe, expect, it } from "vitest";
import { createIngestionHarness } from "../../testing/ingestion-test-support";
import { hour, lockOrphan, minute, seedOrphan } from "./orphan-test-support";

// The SQL cooldown in OrphanSource.listWaiting against the domain's redriveCooldownMs. Its own
// harness: the matrix seeds more documents than one workspace's quota allows next to other tests.
const h = await createIngestionHarness();
const { wsA, wsB } = h;
const source = h.worker.orphanSource;
const day = 24 * hour;

afterAll(() => h.close());

async function scan(): Promise<OrphanCandidate[]> {
  const found: OrphanCandidate[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await source.listWaiting(orphanPageLimit, after);
    found.push(...page.filter((c) => c.workspaceId === wsA || c.workspaceId === wsB));
    const last = page.at(-1);
    if (last === undefined) return found;
    after = last.cursor;
  }
}
const listed = async (id: DocumentVersionId) => (await scan()).some((c) => c.versionId === id);

describe("cooldown", () => {
  it("applies the domain formula to every reachable attempt and history count", async () => {
    const cases: { id: DocumentVersionId; rows: number; attempt: number; cooldown: number }[] = [];
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      for (let rows = 0; rows <= outboxHistoryCap + 1; rows++) {
        const cooldown = redriveCooldownMs(rows, attempt);
        for (const offset of [-2 * minute, 2 * minute]) {
          const id = await seedOrphan(h, rows % 2 === 0 ? wsA : wsB, {
            attempt,
            updatedAgoMs: cooldown + offset,
            history: Array.from({ length: rows }, () => ({
              createdAgoMs: 40 * day,
              dispatchedAgoMs: 30 * day,
            })),
          });
          cases.push({ id, rows, attempt, cooldown: cooldown + offset });
        }
      }
    }
    const found = new Set((await scan()).map((c) => c.versionId));
    for (const { id, rows, attempt, cooldown } of cases) {
      const due = cooldown >= redriveCooldownMs(rows, attempt);
      expect(found.has(id), `rows=${rows} attempt=${attempt} idle=${cooldown}`).toBe(due);
    }
  }, 120_000);

  it("saturates at six hours", async () => {
    const history = Array.from({ length: 12 }, () => ({
      createdAgoMs: 40 * day,
      dispatchedAgoMs: 30 * day,
    }));
    const short = await seedOrphan(h, wsA, { updatedAgoMs: 6 * hour - 2 * minute, history });
    const past = await seedOrphan(h, wsA, { updatedAgoMs: 6 * hour + 2 * minute, history });
    expect(await listed(short)).toBe(false);
    expect(await listed(past)).toBe(true);
  });

  it("measures idle time from the later of updated_at and the latest dispatch", async () => {
    const dispatchedLater = await seedOrphan(h, wsA, {
      updatedAgoMs: 10 * day,
      history: [{ createdAgoMs: 11 * day, dispatchedAgoMs: minute }],
    });
    const updatedLater = await seedOrphan(h, wsA, {
      updatedAgoMs: minute,
      history: [{ createdAgoMs: 11 * day, dispatchedAgoMs: 10 * day }],
    });
    const none = await seedOrphan(h, wsA, { updatedAgoMs: minute });
    const stale = await seedOrphan(h, wsA, {
      updatedAgoMs: 10 * day,
      history: [{ createdAgoMs: 11 * day, dispatchedAgoMs: 9 * day }],
    });
    const found = new Set((await scan()).map((c) => c.versionId));
    expect([dispatchedLater, updatedLater, none].some((id) => found.has(id))).toBe(false);
    expect(found.has(stale)).toBe(true);
  });

  it("takes the maximum dispatched_at even when created_at order disagrees", async () => {
    const id = await seedOrphan(h, wsA, {
      updatedAgoMs: 10 * day,
      history: [
        { createdAgoMs: 9 * day, dispatchedAgoMs: minute },
        { createdAgoMs: 5 * day, dispatchedAgoMs: 8 * day },
        { createdAgoMs: 3 * day, dispatchedAgoMs: 7 * day },
      ],
    });
    expect(await listed(id)).toBe(false);
  });

  it("agrees with lockOrphan on what each listed candidate is", async () => {
    const id = await seedOrphan(h, wsA, {
      attempt: 1,
      updatedAgoMs: 2 * day,
      history: [{ createdAgoMs: 4 * day, dispatchedAgoMs: 3 * day }],
    });
    expect(await listed(id)).toBe(true);
    const snapshot = await lockOrphan(h, wsA, id);
    expect(snapshot && snapshot.idleMs >= redriveCooldownMs(snapshot.outboxRows, 1)).toBe(true);
  });
});
