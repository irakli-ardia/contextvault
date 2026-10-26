#!/usr/bin/env node
// Fails when the committed migrations are inconsistent with each other or with the Drizzle schema.
// Regeneration happens in a temporary copy, so the working tree is never touched.

import { execFileSync } from "node:child_process";
import { cpSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const migrations = resolve("infra/migrations");
const kit = resolve("packages/db/node_modules/.bin/drizzle-kit");
const run = (...args) =>
  execFileSync(kit, args, {
    cwd: "packages/db",
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
const sqlFiles = (dir) => readdirSync(dir).filter((file) => file.endsWith(".sql"));

const driftConfig = resolve("packages/db/drizzle.drift.config.ts");
// drizzle-kit resolves --out relative to its working directory, so the copy lives under it.
const scratch = resolve("packages/db/.drift-migrations");
try {
  run("check");
  rmSync(scratch, { recursive: true, force: true });
  cpSync(migrations, scratch, { recursive: true });
  // --out conflicts with the config file, so regenerate through a throwaway config.
  writeFileSync(
    driftConfig,
    `import { defineConfig } from "drizzle-kit";
export default defineConfig({ dialect: "postgresql", schema: "./src/schema/index.ts", out: "./.drift-migrations" });
`,
  );
  const output = run("generate", "--config", driftConfig, "--name", "drift");
  const added = sqlFiles(scratch).filter((file) => !sqlFiles(migrations).includes(file));
  // drizzle-kit reports some failures on stdout with exit 0, so require its explicit all-clear.
  if (added.length > 0 || !output.includes("No schema changes")) {
    throw new Error("schema changed without a migration: run `pnpm run db:generate` and review it");
  }
  console.log("ok  migrations match the schema");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
  rmSync(driftConfig, { force: true });
}
