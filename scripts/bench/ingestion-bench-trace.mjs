// Wrappers that time the production stages and unit of work without changing them, the
// in-memory object store, and the async context that joins a transaction to the call that opened it.

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

export const now = () => performance.now();
export const als = new AsyncLocalStorage();

/** `then` handlers that call `record` (with the error, if any) and leave the outcome unchanged. */
const settled = (record) => [
  (value) => {
    record();
    return value;
  },
  (error) => {
    record(error);
    throw error;
  },
];

/** In-memory DocumentStore: the S3 adapter's read path is not part of this measurement. */
export function memoryStore() {
  const objects = new Map();
  return {
    objects,
    get: async (key, { maxBytes }) => {
      const bytes = objects.get(key);
      if (bytes && bytes.length > maxBytes) throw new Error("object larger than maxBytes");
      return bytes ?? null;
    },
    put: async () => undefined,
    head: async () => null,
    delete: async () => undefined,
  };
}

const addSub = (field, ms) => {
  const sub = als.getStore()?.sub;
  if (sub) sub[field] = (sub[field] ?? 0) + ms;
};
const timedInto =
  (field, fn) =>
  async (...args) => {
    const start = now();
    try {
      return await fn(...args);
    } finally {
      addSub(field, now() - start);
    }
  };

/** The real stages with their three costs timed, inside a stage span that records `sub`. */
export function tracedStages(ctx) {
  const { lib, h, store, events, parseChild } = ctx;
  const embedder = {
    ...lib.hashEmbedder,
    embed: timedInto("embedMs", (t, s) => lib.hashEmbedder.embed(t, s)),
  };
  const stages = lib.createIngestionStages({
    readBytes: timedInto("readMs", (input) =>
      lib.readVersionBytes(
        { uow: h.worker.parseSourceUnitOfWork, store },
        { ...input, maxBytes: lib.parseLimits.maxInputBytes },
      ),
    ),
    parse: timedInto("parseMs", (bytes, signal) =>
      lib.parseInChild(bytes, signal, { childPath: parseChild }),
    ),
    handoff: lib.createParsedHandoff(),
    embedder,
    newId: randomUUID,
  });
  return {
    run: (input) => {
      const sub = {};
      const startMs = now();
      const record = (error) =>
        events.push({
          type: "stage",
          stage: input.stage,
          versionId: input.versionId,
          startMs,
          endMs: now(),
          sub,
          error: error?.name,
        });
      return als.run({ sub }, () => stages.run(input)).then(...settled(record));
    },
  };
}

/** The real unit of work; each call is one event, tagged so its transaction can be found. */
export function tracedUow(ctx) {
  const { h, events } = ctx;
  let calls = 0;
  return {
    run: (context, work, options) => {
      calls += 1;
      const call = calls;
      const methods = [];
      const traced = (repos) =>
        work({
          ...repos,
          ingestion: new Proxy(repos.ingestion, {
            get: (target, prop) =>
              typeof target[prop] === "function"
                ? (...args) => {
                    methods.push({ method: String(prop), versionId: args[0]?.versionId });
                    return target[prop](...args);
                  }
                : target[prop],
          }),
        });
      const startMs = now();
      const record = (error) =>
        events.push({
          type: "uow",
          call,
          startMs,
          endMs: now(),
          methods,
          error: error?.code ?? error?.name,
        });
      return als
        .run({ call }, () => h.worker.unitOfWork.run(context, traced, options))
        .then(...settled(record));
    },
  };
}
