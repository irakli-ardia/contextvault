// Workspace packages are source-first TypeScript, so everything is bundled, as in packages/db.
export default {
  entry: [new URL("./orphan-sql.entry.mjs", import.meta.url).pathname],
  format: "esm",
  platform: "node",
  target: "node24",
  deps: { alwaysBundle: [/^@contextvault\//, /^drizzle-orm/], onlyBundle: false },
  clean: true,
};
