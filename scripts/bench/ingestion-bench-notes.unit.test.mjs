import { describe, expect, it } from "vitest";
import { LIMITATIONS, limitationsFor } from "./ingestion-bench-notes.mjs";

const ABSENT = /there is no content_tsv column/;

describe("limitationsFor", () => {
  it("keeps the baseline text unchanged, with and without the schema argument", () => {
    expect(limitationsFor(false)).toEqual(LIMITATIONS);
    expect(limitationsFor(false, "baseline")).toEqual(LIMITATIONS);
    expect(limitationsFor(false, "baseline").join("\n")).toMatch(ABSENT);
  });
  it("never claims the column is absent for stored-tsv, and says it is not compared here", () => {
    for (const serverStats of [false, true]) {
      const text = limitationsFor(serverStats, "stored-tsv").join("\n");
      expect(text).not.toMatch(ABSENT);
      expect(text).not.toMatch(/current schema only/);
      expect(text).toMatch(/stored-tsv arm only/);
      expect(text).toMatch(/not compared with the baseline arm/);
    }
  });
  it("keeps the server-statistics substitution in both arms", () => {
    for (const arm of ["baseline", "stored-tsv"]) {
      const text = limitationsFor(true, arm).join("\n");
      expect(text).toMatch(/--server-stats changes deadlock_timeout/);
      expect(text).not.toMatch(/no database-server execution time is measured/);
    }
  });
});
