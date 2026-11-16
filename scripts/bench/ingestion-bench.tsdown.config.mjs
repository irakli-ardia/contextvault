// Workspace packages are source-first TypeScript, so they are bundled (zod as in the worker's own
// build). bullmq, pg, ioredis and drizzle stay external and resolve from apps/worker/node_modules,
// which is why the bundle is written under apps/worker/dist and not a system temp directory.
export default {
  entry: [new URL("./ingestion-bench.entry.mjs", import.meta.url).pathname],
  format: "esm",
  platform: "node",
  target: "node24",
  deps: {
    neverBundle: ["pg", "bullmq", "ioredis", /^drizzle-orm/],
    alwaysBundle: [/^@contextvault\//, "zod"],
    onlyBundle: false,
  },
  clean: true,
};
