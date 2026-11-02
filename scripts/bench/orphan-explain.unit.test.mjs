import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProduction } from "./orphan-explain.mjs";

// Fake bundler: writes the entry module the harness imports into the `-d` directory.
const FAKE_TSDOWN = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const out = process.argv[process.argv.indexOf("-d") + 1];
writeFileSync(join(out, "orphan-sql.entry.mjs"), "export class PgDialect {}");
`;

describe("loadProduction temp-directory cleanup", () => {
  let tmp;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cv-bench-test-"));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("removes the bundle directory after a successful load", async () => {
    const tsdown = join(tmp, "fake-tsdown.mjs");
    writeFileSync(tsdown, FAKE_TSDOWN);
    chmodSync(tsdown, 0o755);
    const work = mkdtempSync(join(tmp, "work-"));
    const prod = await loadProduction({ tmp: work, tsdown });
    expect(prod.dialect).toBeDefined();
    expect(readdirSync(work)).toEqual([]);
  });

  it("removes the bundle directory when bundling fails", async () => {
    const work = mkdtempSync(join(tmp, "work-"));
    await expect(loadProduction({ tmp: work, tsdown: join(tmp, "missing") })).rejects.toThrow(
      /bundle failed/,
    );
    expect(readdirSync(work)).toEqual([]);
  });

  it("removes the bundle directory when the bundle fails to import", async () => {
    const tsdown = join(tmp, "empty-tsdown.sh");
    writeFileSync(tsdown, "#!/bin/sh\nexit 0\n");
    chmodSync(tsdown, 0o755);
    const work = mkdtempSync(join(tmp, "work-"));
    await expect(loadProduction({ tmp: work, tsdown })).rejects.toThrow();
    expect(readdirSync(work)).toEqual([]);
  });
});
