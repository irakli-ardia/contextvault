import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Companion of deletion-grants.integration.test.ts, DB-free: no production code may write
// `documents.deleted_at`. Recovery discovery cannot see deleted documents, so a delete path must
// ship with the M1.7 command that closes the document's non-terminal versions in the same
// transaction (status failed, error_code document.deleted, not retryable). Reads (`is null`,
// `isNull(`, selects) are fine; this looks for assignments.
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

const writesDeletedAt = /deleted_at\s*=(?!=)|\.set\(\s*\{[^}]*deletedAt/i;

describe("document deletion path", () => {
  it("exists nowhere in production code before the M1.7 delete command", () => {
    const files = ["apps", "packages"].flatMap((top) =>
      readdirSync(join(root, top)).flatMap((pkg) => [...sources(join(root, top, pkg, "src"))]),
    );
    expect(files.length).toBeGreaterThan(50);
    const offenders = files.filter((file) => writesDeletedAt.test(readFileSync(file, "utf8")));
    expect(offenders.map((f) => f.slice(root.length))).toEqual([]);
  });
});
