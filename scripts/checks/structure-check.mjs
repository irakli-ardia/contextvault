#!/usr/bin/env node
// Deterministic file-placement rules (see docs/engineering-standards.md, "Repository structure"):
//   1. an `*.integration.test.ts` file sits under an `integration/` directory that a feature owns:
//      `<feature>/integration/…`, or `src/integration/<area>/…` (never directly in `src/integration/`)
//   2. integration tests use the `.ts` extension, the only one the integration project discovers
//   3. no file or directory is named utils, helpers, common, misc, manager or shared
//   4. at least one source file is scanned, so a wrong root cannot pass silently
//
// LEGACY_FILES is the exact list of misplaced integration tests still waiting for their slice.
// A file leaves the list in the slice that moves it, and a stale entry fails the check, so the
// list can only shrink. Never add to it: move the new test instead (structure-check.unit.test.mjs
// pins the ceiling).
//
// Reads the working tree (tracked and untracked, minus ignored), so uncommitted moves count.
// Usage: structure-check.mjs [root]. The default root is the repository holding this script.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const LEGACY_FILES = new Set([
  "apps/api/src/auth/auth-flow.integration.test.ts",
  "apps/api/src/auth/guards.integration.test.ts",
  "apps/api/src/auth/lifecycle.integration.test.ts",
  "apps/api/src/auth/limits.integration.test.ts",
  "apps/api/src/raw-body-transport.integration.test.ts",
  "apps/api/src/storage/s3-document-store-deadline.integration.test.ts",
  "apps/api/src/storage/s3-document-store-guarantees.integration.test.ts",
  "apps/api/src/storage/s3-document-store-incomplete.integration.test.ts",
  "apps/api/src/storage/s3-document-store.integration.test.ts",
  "apps/worker/src/bullmq-job-queue.integration.test.ts",
  "apps/worker/src/delayed-redelivery.integration.test.ts",
  "apps/worker/src/ingestion-consumer-shutdown.integration.test.ts",
  "apps/worker/src/ingestion-consumer.integration.test.ts",
  "apps/worker/src/ingestion-heartbeat.integration.test.ts",
  "apps/worker/src/lease-heartbeat.integration.test.ts",
  "apps/worker/src/outbox-dispatch.integration.test.ts",
  "apps/worker/src/redis-connection.integration.test.ts",
  "packages/db/src/auth-rls.integration.test.ts",
  "packages/db/src/auth-stores.integration.test.ts",
  "packages/db/src/catalog-invariants.integration.test.ts",
  "packages/db/src/connection-reuse.integration.test.ts",
  "packages/db/src/database-roles.integration.test.ts",
  "packages/db/src/document-constraints.integration.test.ts",
  "packages/db/src/documents-rls.integration.test.ts",
  "packages/db/src/fixture-connections.integration.test.ts",
  "packages/db/src/ingestion-claim.integration.test.ts",
  "packages/db/src/ingestion-flow.integration.test.ts",
  "packages/db/src/ingestion-lock-order.integration.test.ts",
  "packages/db/src/ingestion-outbox.integration.test.ts",
  "packages/db/src/orphan-concurrency.integration.test.ts",
  "packages/db/src/orphan-discovery-cooldown.integration.test.ts",
  "packages/db/src/orphan-discovery.integration.test.ts",
  "packages/db/src/orphan-interleaving.integration.test.ts",
  "packages/db/src/orphan-rls.integration.test.ts",
  "packages/db/src/orphan-transaction.integration.test.ts",
  "packages/db/src/orphan.integration.test.ts",
  "packages/db/src/privilege-check.integration.test.ts",
  "packages/db/src/recovery-concurrency.integration.test.ts",
  "packages/db/src/recovery.integration.test.ts",
  "packages/db/src/reservation-lost-ack.integration.test.ts",
  "packages/db/src/role-boundaries.integration.test.ts",
  "packages/db/src/role-model.integration.test.ts",
  "packages/db/src/transaction-timeouts.integration.test.ts",
  "packages/db/src/upload-document.integration.test.ts",
  "packages/db/src/upload-finalize.integration.test.ts",
  "packages/db/src/upload-outbox.integration.test.ts",
  "packages/db/src/upload-quota.integration.test.ts",
  "packages/db/src/upload-reservations.integration.test.ts",
  "packages/db/src/worker-rls.integration.test.ts",
  "packages/db/src/workspace-bootstrap.integration.test.ts",
  "packages/db/src/workspace-isolation.integration.test.ts",
]);

const SOURCE = /^(apps|packages)\/[^/]+\/src\/(.+)$/;
const BANNED_NAME = /^(utils?|helpers?|common|misc|manager|shared)$/;

function placementFault(sourcePath) {
  const dirs = sourcePath.split("/").slice(0, -1);
  if (!dirs.includes("integration")) return 'belongs in a feature\'s "integration" directory';
  if (dirs.length === 1)
    return 'catch-all "integration" directory at the workspace root: use <feature>/integration/ or integration/<area>/';
  return null;
}

function fileProblems(file, sourcePath, legacy) {
  const problems = [];
  if (file.split("/").some((s) => BANNED_NAME.test(s.replace(/\..*$/, "")))) {
    problems.push(`${file}: generic name (utils, helpers, common, misc, manager, shared)`);
  }
  if (!file.includes(".integration.test.")) return problems;
  if (!file.endsWith(".integration.test.ts")) {
    problems.push(`${file}: integration tests must be .ts; other extensions are never run`);
    return problems;
  }
  const fault = placementFault(sourcePath);
  if (fault && !legacy.has(file)) problems.push(`${file}: ${fault}`);
  return problems;
}

function staleProblem(entry, present) {
  if (!present.has(entry)) return `${entry}: stale LEGACY_FILES entry, file is gone: remove it`;
  const match = SOURCE.exec(entry);
  if (match && !placementFault(match[2]))
    return `${entry}: stale LEGACY_FILES entry, now placed correctly: remove it`;
  return undefined;
}

export function findProblems(files, legacy = LEGACY_FILES) {
  const present = new Set(files);
  const scanned = files.filter((file) => SOURCE.test(file));
  const problems = scanned.flatMap((file) => fileProblems(file, SOURCE.exec(file)[2], legacy));
  if (scanned.length === 0) problems.push("no source files scanned: wrong root or empty checkout");
  for (const entry of legacy) {
    const stale = staleProblem(entry, present);
    if (stale) problems.push(stale);
  }
  return problems;
}

export function listFiles(root) {
  return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter((file) => file && existsSync(join(root, file))); // moved files stay in the index until staged
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root =
    process.argv[2] ??
    execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: dirname(fileURLToPath(import.meta.url)),
      encoding: "utf8",
    }).trim();
  const problems = findProblems(listFiles(root));
  if (problems.length > 0) {
    console.error(`structure-check: ${problems.length} problem(s)\n${problems.join("\n")}`);
    process.exit(1);
  }
  console.log("structure-check: ok");
}
