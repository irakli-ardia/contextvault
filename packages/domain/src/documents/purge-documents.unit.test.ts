import { describe, expect, it, vi } from "vitest";
import { parseDocumentId, parseDocumentVersionId, parseWorkspaceId } from "../kernel/ids";
import { StorageError } from "./errors";
import type { DeadlineSignal, DocumentStore } from "./ports";
import { createPurgeSweep, purgeDocument } from "./purge-documents";
import type { PurgeCandidate, PurgeRepository, PurgeSource, PurgeUnitOfWork } from "./purge-ports";

const workspaceId = parseWorkspaceId("0b1c9d3e-5a7f-4c2d-8e1f-3a4b5c6d7e8f");
const docId = (n: number) =>
  parseDocumentId(`3b1c9d3e-5a7f-4c2d-8e1f-3a4b5c6d7e${n.toString(16).padStart(2, "0")}`);
const v1 = parseDocumentVersionId("5b1c9d3e-5a7f-4c2d-8e1f-3a4b5c6d7e01");
const v2 = parseDocumentVersionId("5b1c9d3e-5a7f-4c2d-8e1f-3a4b5c6d7e02");
const retentionMs = 1000;
const noop = (): void => undefined;
const fakeStore = (del: DocumentStore["delete"]): DocumentStore => ({
  put: async () => undefined,
  get: async () => null,
  head: async () => null,
  delete: del,
});
const idle: PurgeRepository = { readTargets: async () => null, finalize: async () => false };
const newSignal = (): DeadlineSignal & { aborted: boolean } => ({
  aborted: false,
  addEventListener: noop,
  removeEventListener: noop,
});

function setup(
  over: {
    targets?: PurgeRepository["readTargets"];
    finalize?: PurgeRepository["finalize"];
    del?: DocumentStore["delete"];
  } = {},
) {
  const events: string[] = [];
  const purge: PurgeRepository = {
    readTargets:
      over.targets ??
      (async () => {
        events.push("read");
        return [v1, v2];
      }),
    finalize:
      over.finalize ??
      (async () => {
        events.push("finalize");
        return true;
      }),
  };
  const uow: PurgeUnitOfWork = { run: async (_ctx, work) => work({ purge }) };
  const store = fakeStore(
    over.del ??
      (async (key) => {
        events.push(`delete ${key.slice(-2)}`);
      }),
  );
  return { deps: { uow, store }, events };
}

describe("purgeDocument", () => {
  it("deletes every object before the rows are finalized", async () => {
    const { deps, events } = setup();
    expect(await purgeDocument(deps, { workspaceId, documentId: docId(1), retentionMs })).toBe(
      "purged",
    );
    expect(events).toEqual(["read", "delete 01", "delete 02", "finalize"]);
  });

  it("touches nothing for an ineligible document", async () => {
    const del = vi.fn();
    const finalize = vi.fn();
    const { deps } = setup({ targets: async () => null, del, finalize });
    expect(await purgeDocument(deps, { workspaceId, documentId: docId(1), retentionMs })).toBe(
      "skipped",
    );
    expect(del).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
  });

  it("never finalizes when an object delete fails, so the document stays eligible", async () => {
    const finalize = vi.fn();
    const { deps } = setup({
      del: async () => {
        throw new StorageError("storage.unavailable", true);
      },
      finalize,
    });
    await expect(
      purgeDocument(deps, { workspaceId, documentId: docId(1), retentionMs }),
    ).rejects.toBeInstanceOf(StorageError);
    expect(finalize).not.toHaveBeenCalled();
  });

  it("reports skipped when finalize refuses", async () => {
    const { deps } = setup({ finalize: async () => false });
    expect(await purgeDocument(deps, { workspaceId, documentId: docId(1), retentionMs })).toBe(
      "skipped",
    );
  });

  it("reuses the same deterministic keys on a repeat, so a retry deletes the same objects", async () => {
    const keys: string[] = [];
    const { deps } = setup({
      del: async (key) => {
        keys.push(key);
      },
    });
    await purgeDocument(deps, { workspaceId, documentId: docId(1), retentionMs });
    await purgeDocument(deps, { workspaceId, documentId: docId(1), retentionMs });
    expect(keys).toHaveLength(4);
    expect(keys.slice(0, 2)).toEqual(keys.slice(2));
    expect(keys[0]).toBe(`ws/${workspaceId}/doc/${docId(1)}/v/${v1}`);
  });
});

const candidate = (n: number): PurgeCandidate => ({
  workspaceId,
  documentId: docId(n),
  cursor: `c${n}`,
});

function sweepSetup(pages: PurgeCandidate[][], failing: number[] = [], batchSize = 2) {
  const afters: (string | undefined)[] = [];
  const source: PurgeSource = {
    listEligible: async ({ after }) => {
      afters.push(after);
      return pages.shift() ?? [];
    },
  };
  const purged: string[] = [];
  const purge: PurgeRepository = {
    readTargets: async ({ documentId }) => {
      if (failing.some((n) => docId(n) === documentId)) throw new Error("db down");
      purged.push(documentId);
      return [v1];
    },
    finalize: async () => true,
  };
  const uow: PurgeUnitOfWork = { run: async (_c, work) => work({ purge }) };
  const store = fakeStore(async () => undefined);
  const sweep = createPurgeSweep({ uow, store, source, batchSize, retentionMs });
  return { sweep, afters, purged };
}

describe("createPurgeSweep", () => {
  it("advances a cursor on full pages and wraps to the start on a short page", async () => {
    const { sweep, afters } = sweepSetup([
      [candidate(1), candidate(2)],
      [candidate(3)],
      [candidate(4)],
    ]);
    await sweep();
    await sweep();
    await sweep();
    expect(afters).toEqual([undefined, "c2", undefined]);
  });

  it("returns a failing document in errors and still purges the rest", async () => {
    const { sweep, purged } = sweepSetup([[candidate(1), candidate(2)]], [1]);
    const batch = await sweep();
    expect(batch).toMatchObject({ candidates: 2, purged: 1, skipped: 0 });
    expect(batch.errors).toHaveLength(1);
    expect(purged).toEqual([docId(2)]);
  });

  it("lets a poison document at the head be passed over by the cursor", async () => {
    const { sweep, afters } = sweepSetup([[candidate(1), candidate(2)], [candidate(3)]], [1, 2]);
    await sweep();
    await sweep();
    expect(afters[1]).toBe("c2");
  });

  it("starts no document once aborted, and runs no discovery when aborted first", async () => {
    const { sweep, purged, afters } = sweepSetup([[candidate(1), candidate(2)]]);
    const controller = newSignal();
    controller.aborted = true;
    expect(await sweep(controller)).toEqual({
      candidates: 0,
      purged: 0,
      skipped: 0,
      errors: [],
    });
    expect(afters).toEqual([]);
    expect(purged).toEqual([]);
  });

  it("stops between documents when aborted mid-batch", async () => {
    const controller = newSignal();
    const afters: unknown[] = [];
    const purge: PurgeRepository = {
      readTargets: async () => {
        controller.aborted = true;
        return [v1];
      },
      finalize: async () => true,
    };
    const sweep = createPurgeSweep({
      uow: { run: async (_c, work) => work({ purge }) },
      store: fakeStore(async () => undefined),
      source: {
        listEligible: async () => {
          afters.push(1);
          return [candidate(1), candidate(2)];
        },
      },
      batchSize: 2,
      retentionMs,
    });
    expect(await sweep(controller)).toMatchObject({ purged: 1 });
  });

  it("propagates a discovery failure", async () => {
    const sweep = createPurgeSweep({
      uow: { run: async (_c, work) => work({ purge: idle }) },
      store: fakeStore(async () => undefined),
      source: {
        listEligible: async () => {
          throw new Error("down");
        },
      },
      batchSize: 2,
      retentionMs,
    });
    await expect(sweep()).rejects.toThrow("down");
  });
});
