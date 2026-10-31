import { describe, expect, it } from "vitest";
import { parseIngestionPayload } from "./ingestion-job";

const ws = "00000000-0000-4000-8000-000000000001";
const version = "00000000-0000-4000-8000-000000000002";

describe("parseIngestionPayload", () => {
  it("accepts exactly the two ids", () => {
    expect(parseIngestionPayload({ workspaceId: ws, versionId: version })).toEqual({
      workspaceId: ws,
      versionId: version,
    });
  });

  it.each([
    ["null", null],
    ["a string", ws],
    ["an array", [ws, version]],
    ["missing version", { workspaceId: ws }],
    ["non-string id", { workspaceId: ws, versionId: 7 }],
    ["malformed id", { workspaceId: ws, versionId: "nope" }],
    ["an extra key", { workspaceId: ws, versionId: version, extra: 1 }],
  ])("rejects %s", (_name, data) => {
    expect(parseIngestionPayload(data)).toBeNull();
  });
});
