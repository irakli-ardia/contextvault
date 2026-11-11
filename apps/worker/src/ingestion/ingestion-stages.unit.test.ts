import {
  parseDocumentVersionId,
  parseWorkspaceId,
  StageFailure,
  type StageInput,
} from "@contextvault/domain";
import { type ParsedDocument, ParseFailure } from "@contextvault/ingestion";
import { describe, expect, it } from "vitest";
import { createIngestionStages } from "./ingestion-stages";
import { createParsedHandoff } from "./parsed-handoff";

const versionId = parseDocumentVersionId("00000000-0000-4000-8000-000000000003");
const workspaceId = parseWorkspaceId("00000000-0000-4000-8000-000000000001");
const document: ParsedDocument = { format: "text", text: "hello" };
const live = {
  aborted: false,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};
const input = (stage: StageInput["stage"], leaseGeneration = 1, signal = live): StageInput => ({
  stage,
  workspaceId,
  versionId,
  leaseGeneration,
  signal,
});

function setup(over: { parse?: () => Promise<ParsedDocument> } = {}) {
  const handoff = createParsedHandoff();
  const calls: string[] = [];
  const stages = createIngestionStages({
    readBytes: async () => {
      calls.push("read");
      return new Uint8Array([1]);
    },
    parse: over.parse ?? (async () => document),
    handoff,
  });
  return { stages, handoff, calls };
}

describe("ingestion stages", () => {
  it("parses, hands the document over, and the chunking stage takes it exactly once", async () => {
    const { stages, handoff } = setup();
    await stages.run(input("parsing"));
    await stages.run(input("chunking"));
    expect(handoff.take({ versionId, leaseGeneration: 1 })).toBeUndefined();
    await expect(stages.run(input("chunking"))).rejects.toMatchObject({
      code: "handoff.missing",
      retryable: true,
    });
  });

  it("never lets a newer claim take an older claim's document", async () => {
    const { stages } = setup();
    await stages.run(input("parsing", 1));
    await expect(stages.run(input("chunking", 2))).rejects.toBeInstanceOf(StageFailure);
  });

  it("hands nothing over once the lease is lost", async () => {
    const { stages, handoff } = setup();
    await stages.run(input("parsing", 1, { ...live, aborted: true }));
    expect(handoff.take({ versionId, leaseGeneration: 1 })).toBeUndefined();
  });

  it("lets a parse failure through with its code and hands nothing over", async () => {
    const { stages, handoff } = setup({
      parse: async () => {
        throw new ParseFailure("parse.encrypted");
      },
    });
    await expect(stages.run(input("parsing"))).rejects.toMatchObject({
      code: "parse.encrypted",
      retryable: false,
    });
    expect(handoff.take({ versionId, leaseGeneration: 1 })).toBeUndefined();
  });
});

describe("handoff bound", () => {
  it("keeps one entry per version and drops the oldest past the bound", () => {
    const handoff = createParsedHandoff(2);
    const id = (n: number) => parseDocumentVersionId(`00000000-0000-4000-8000-00000000010${n}`);
    for (const n of [1, 2, 3]) handoff.put({ versionId: id(n), leaseGeneration: 1 }, document);
    expect(handoff.take({ versionId: id(1), leaseGeneration: 1 })).toBeUndefined();
    expect(handoff.take({ versionId: id(3), leaseGeneration: 1 })).toEqual(document);
    handoff.put({ versionId: id(2), leaseGeneration: 1 }, document);
    handoff.put({ versionId: id(2), leaseGeneration: 2 }, document);
    expect(handoff.take({ versionId: id(2), leaseGeneration: 1 })).toBeUndefined();
  });
});
