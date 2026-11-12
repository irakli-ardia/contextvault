import { describe, expect, it } from "vitest";
import { parseAnswerResponse } from "./answers";

const citation = {
  chunkId: "c",
  documentId: "d",
  displayName: "n.txt",
  startOffset: 0,
  endOffset: 3,
  excerpt: "abc",
};

describe("parseAnswerResponse", () => {
  it("accepts an answer and an abstention", () => {
    const answer = { kind: "answer", model: "m", text: "t", citations: [citation] };
    expect(parseAnswerResponse(answer)).toEqual(answer);
    const abstention = { kind: "insufficient_evidence", model: "m", reason: "no_evidence" };
    expect(parseAnswerResponse(abstention)).toEqual(abstention);
  });

  it.each([
    [null],
    [{ kind: "answer", model: "m", text: "t", citations: [{ ...citation, startOffset: -1 }] }],
    [{ kind: "answer", model: "m", text: "t", citations: [citation], extra: 1 }],
    [{ kind: "insufficient_evidence", model: "m", reason: "other" }],
    [{ kind: "nope", model: "m" }],
  ])("rejects %j", (value) => {
    expect(parseAnswerResponse(value)).toBeNull();
  });
});
