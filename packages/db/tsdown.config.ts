import { defineConfig } from "tsdown";

// Workspace packages are source-first TypeScript, so they must be bundled, not left external.
export default defineConfig({
  entry: ["src/migrate.ts"],
  format: "esm",
  platform: "node",
  target: "node24",
  deps: { alwaysBundle: [/^@contextvault\//], onlyBundle: ["zod"] },
  clean: true,
});
