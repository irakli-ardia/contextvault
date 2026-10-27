import { describe, expect, it } from "vitest";
import { parseDocumentId, parseDocumentVersionId, parseWorkspaceId } from "../kernel/ids";
import { StorageError } from "./errors";
import { documentObjectKey, parseStorageKey } from "./storage-key";

const ws = "0b1c9d3e-5a7f-4c2d-8e1f-3a4b5c6d7e8f";
const doc = "1b1c9d3e-5a7f-4c2d-8e1f-3a4b5c6d7e8f";
const ver = "2b1c9d3e-5a7f-4c2d-8e1f-3a4b5c6d7e8f";

describe("storage keys", () => {
  it("is built from the three server-issued ids only", () => {
    const key = documentObjectKey(
      parseWorkspaceId(ws),
      parseDocumentId(doc),
      parseDocumentVersionId(ver),
    );
    expect(key).toBe(`ws/${ws}/doc/${doc}/v/${ver}`);
  });

  it.each([
    "",
    `ws/${ws}/doc/${doc}/v/${ver}.pdf`,
    `ws/${ws}/doc/${doc}/v/${ver}/`,
    `/ws/${ws}/doc/${doc}/v/${ver}`,
    `ws/${ws}/doc/${doc}/v/../${ver}`,
    `ws/${ws}/doc/${doc}/v/${ver}\n`,
    `ws/${ws}/doc/${doc}/v/${ver}?x=1`,
    `ws/${ws}/doc/${doc}`,
    `ws/${ws.toUpperCase()}/doc/${doc}/v/${ver}`,
    "ws/a/doc/b/v/c",
  ])("rejects %j", (value) => {
    expect(() => parseStorageKey(value)).toThrow(StorageError);
  });
});
