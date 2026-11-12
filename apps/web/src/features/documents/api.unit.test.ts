import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../lib/http-client";
import { getDocument, listDocuments, retryDocument } from "./api";

const doc = {
  id: "d1",
  displayName: "a.txt",
  mime: "text/plain",
  sizeBytes: 3,
  status: "failed",
  error: { code: "parse.empty", retryable: true },
  createdAt: "2026-11-12T10:00:00.000Z",
};

function stubFetch(body: unknown, status = 200) {
  const fn = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
    Response.json(body, { status }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe("documents DAL", () => {
  it("encodes ids into the path so none can add a segment or query", async () => {
    const fn = stubFetch({ documents: [] });
    await listDocuments("w/../x?y");
    expect(fn.mock.calls[0]?.[0]).toBe("/api/workspaces/w%2F..%2Fx%3Fy/documents");
  });

  it("validates a document and posts retry", async () => {
    const fn = stubFetch(doc, 202);
    expect((await retryDocument("w1", "d1")).status).toBe("failed");
    expect(fn.mock.calls[0]).toMatchObject([
      "/api/workspaces/w1/documents/d1/retry",
      { method: "POST" },
    ]);
  });

  it("rejects a body that is not the contract", async () => {
    stubFetch({ ...doc, status: "exploded" });
    await expect(getDocument("w1", "d1")).rejects.toMatchObject({
      code: "response.invalid",
      name: HttpError.name,
    });
  });
});
