import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Companion of deletion-grants.integration.test.ts, DB-free: the only production code that writes
// `documents.deleted_at` is the delete command's repository, and it closes the document's
// non-terminal versions in the same file (status failed, error_code document.deleted, not
// retryable, lease generation bumped). Recovery discovery cannot see deleted documents, so a second
// writer would leave versions that starve it. Reads (`is null`, `isNull(`, selects) are fine; this
// looks for assignments.
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const skipDir = /(^|\/)(node_modules|dist|\.next|integration|testing|e2e)$/;
const testFile = /\.(unit\.|integration\.)?test\.|-support\.ts$/;

function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skipDir.test(path)) yield* sources(path);
    } else if (/\.(ts|tsx|mjs)$/.test(entry.name) && !testFile.test(entry.name)) yield path;
  }
}

const deleteCommand = "packages/db/src/repositories/documents/document-deletion.ts";
const writesDeletedAt = /deleted_at\s*=(?!=)|\.set\(\s*\{[^}]*deletedAt/i;

describe("document deletion path", () => {
  it("is written only by the delete command, which closes the versions with it", () => {
    const files = ["apps", "packages"].flatMap((top) =>
      readdirSync(join(root, top)).flatMap((pkg) => [...sources(join(root, top, pkg, "src"))]),
    );
    expect(files.length).toBeGreaterThan(50);
    const offenders = files.filter((file) => writesDeletedAt.test(readFileSync(file, "utf8")));
    expect(offenders.map((f) => f.slice(root.length))).toEqual([deleteCommand]);
    const source = readFileSync(join(root, deleteCommand), "utf8");
    for (const required of [
      "'document.deleted'",
      "error_retryable = false",
      "error_stage = null",
      "lease_generation = lease_generation + 1",
      "active_version_id = null",
    ]) {
      expect(source).toContain(required);
    }
  });
});
