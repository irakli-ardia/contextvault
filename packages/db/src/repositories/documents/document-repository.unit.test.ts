import { describe, expect, it } from "vitest";
import { toSummary } from "./document-repository";

const row = (status: string | null) => ({
  id: "00000000-0000-4000-8000-000000000001",
  displayName: "notes.txt",
  mime: "text/plain",
  sizeBytes: 12,
  createdAt: new Date("2026-10-30T12:00:00Z"),
  status,
});

describe("toSummary", () => {
  it.each(["uploaded", "processed", "ready", "failed"])("accepts status %s", (status) => {
    expect(toSummary(row(status)).status).toBe(status);
  });

  it.each([null, "unknown"])("rejects status %s", (status) => {
    expect(() => toSummary(row(status))).toThrow("Unexpected document row in database");
  });
});
