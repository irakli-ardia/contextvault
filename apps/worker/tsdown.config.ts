import { defineConfig } from "tsdown";

// Workspace packages are source-first TypeScript, so they must be bundled, not left external.
// The parser child is a second entry with unpdf bundled in; it may read the build directory only.
export default defineConfig({
  entry: ["src/main.ts", "src/parse-child.ts"],
  format: "esm",
  platform: "node",
  target: "node24",
  deps: { alwaysBundle: [/^@contextvault\//, "unpdf"], onlyBundle: ["zod", "unpdf"] },
  clean: true,
});
