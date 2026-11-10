import { randomUUID } from "node:crypto";
import { loadWorkerEnv } from "@contextvault/config";
import { createIngestionHarness } from "@contextvault/db/testing/ingestion";
import {
  dispatchOutbox,
  leaseDurationMs,
  recoverExpiredLease,
  redriveOrphan,
  sweepRecovery,
} from "@contextvault/domain";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createJobQueue } from "../../queue/bullmq-job-queue";
import { testRedisUrl } from "../../testing/test-redis-url";

// Real PostgreSQL (worker role) and real BullMQ on the isolated stack. Discovery is narrowed to this
// file's workspaces: other files share the database and a sweep must never touch their rows.
// The Redis guard runs before the database harness so a bare local run touches neither.
// biome-ignore lint/style/noProcessEnv: launch flags set by the wrapper or the CI runner, not config
const flags = process.env;
const redisUrl = testRedisUrl(loadWorkerEnv().REDIS_URL, flags);
const h = await createIngestionHarness();
const { wsA, wsB, worker } = h;
const own = new Set<string>([wsA, wsB]);
const queueName = `cvtest-sweep-${randomUUID()}`;

let redis: Redis;
let inspect: Queue;
let jobQueue: ReturnType<typeof createJobQueue>;

beforeAll(async () => {
  redis = new Redis(redisUrl.toString(), { maxRetriesPerRequest: null });
  inspect = new Queue(queueName, { connection: redis });
  jobQueue = createJobQueue({ connection: redis, queueName });
});
afterAll(async () => {
  await inspect.obliterate({ force: true });
  await inspect.close();
  await jobQueue.close();
  redis.disconnect();
  await h.close();
});

const sweep = (batchSize = 50) =>
  sweepRecovery(
    {
      recoverySource: {
        listExpiredLeases: async (limit, ms) =>
          (await worker.recoverySource.listExpiredLeases(1_000, ms))
            .filter((c) => own.has(c.workspaceId))
            .slice(0, limit),
      },
      orphanSource: {
        listWaiting: async (limit) =>
          (await worker.orphanSource.listWaiting(500))
            .filter((c) => own.has(c.workspaceId))
            .slice(0, limit),
      },
      recover: (input) =>
        recoverExpiredLease({ uow: worker.recoveryUnitOfWork, newId: randomUUID }, input),
      redrive: (input) => redriveOrphan({ uow: worker.orphanUnitOfWork, newId: randomUUID }, input),
      leaseDurationMs,
    },
    batchSize,
  );
const dispatch = () =>
  dispatchOutbox({ source: h.ownSource, queue: jobQueue, uow: worker.unitOfWork }, 100);
const live = async (id: string) => (await h.outboxRows(id)).filter((r) => r.dispatched_at === null);
const age = async (id: string, ms: number) => {
  await h.fx.fixture.query(
    "update document_versions set updated_at = now() - $2 * interval '1 millisecond' where id = $1",
    [id, ms],
  );
  await h.fx.fixture.query(
    `update outbox set dispatched_at = now() - $2 * interval '1 millisecond'
     where version_id = $1 and dispatched_at is not null`,
    [id, ms],
  );
};
const jobFor = async (id: string) =>
  (await inspect.getJobs(["waiting", "delayed", "active", "completed"])).filter(
    (j) => j.data.versionId === id,
  );

describe("recovery sweep against PostgreSQL and BullMQ", () => {
  it("kill and recover: an expired lease is fenced out, re-queued once and redelivered", async () => {
    const id = await h.seed(wsA, { status: "parsing", attempt: 1, outboxDelayMs: null });
    await h.fx.fixture.query(
      "update document_versions set lease_generation = 1, updated_at = now() - interval '10 minutes' where id = $1",
      [id],
    );
    const first = await sweep();
    expect(first.leases).toMatchObject({ acted: 1, errors: [] });
    expect(await h.row(id)).toMatchObject({ status: "queued", lease_generation: 2, attempt: 1 });
    expect(await live(id)).toHaveLength(1);

    await h.makeDue(id); // the retry entry carries its backoff delay
    await dispatch();
    expect(await jobFor(id)).toHaveLength(1);
  });

  it("repeated sweeps are idempotent", async () => {
    const id = await h.seed(wsA, { status: "chunking", attempt: 1, outboxDelayMs: null });
    await h.fx.fixture.query(
      "update document_versions set updated_at = now() - interval '10 minutes' where id = $1",
      [id],
    );
    await sweep();
    const snapshot = [await h.row(id), (await h.outboxRows(id)).length];
    for (let i = 0; i < 3; i += 1) await sweep();
    expect([await h.row(id), (await h.outboxRows(id)).length]).toEqual(snapshot);
    expect((await h.row(id)).lease_generation).toBe(1);
  });

  it("Redis flush: a dispatched job Redis lost is redriven from database state", async () => {
    const id = await h.seed(wsB, { status: "uploaded" });
    await dispatch();
    expect(await jobFor(id)).toHaveLength(1);
    await inspect.obliterate({ force: true });
    expect(await jobFor(id)).toHaveLength(0);

    expect((await sweep()).orphans.acted).toBe(0); // still cooling down: no redrive yet
    await age(id, 10 * 60_000);
    expect((await sweep()).orphans).toMatchObject({ acted: 1, errors: [] });
    expect(await live(id)).toHaveLength(1);
    await dispatch();
    expect(await jobFor(id)).toHaveLength(1);
    await sweep();
    expect(await live(id)).toHaveLength(0); // dispatched, no second live entry
  });

  it("respects the batch size", async () => {
    const ids = await Promise.all(
      [1, 2, 3].map(() => h.seed(wsA, { status: "parsing", attempt: 1, outboxDelayMs: null })),
    );
    await Promise.all(
      ids.map((id) =>
        h.fx.fixture.query(
          "update document_versions set updated_at = now() - interval '10 minutes' where id = $1",
          [id],
        ),
      ),
    );
    const r = await sweep(2);
    expect(r.leases).toMatchObject({ candidates: 2, acted: 2 });
    expect((await sweep(2)).leases).toMatchObject({ candidates: 1, acted: 1 });
  });
});
