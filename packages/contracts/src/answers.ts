// Response shape of POST /workspaces/{workspaceId}/answers. A citation names a chunk the server
// resolved for this caller; the web app renders `excerpt` as plain text only.

export interface CitationResponse {
  readonly chunkId: string;
  readonly documentId: string;
  readonly displayName: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly excerpt: string;
}

export type AnswerResponse =
  | {
      readonly kind: "answer";
      readonly model: string;
      readonly text: string;
      readonly citations: readonly CitationResponse[];
    }
  | {
      readonly kind: "insufficient_evidence";
      readonly model: string;
      readonly reason: "no_evidence" | "not_supported";
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isOffset = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

function parseCitation(value: unknown): CitationResponse | null {
  if (!isRecord(value) || Object.keys(value).length !== 6) return null;
  const { chunkId, documentId, displayName, startOffset, endOffset, excerpt } = value;
  if (typeof chunkId !== "string" || typeof documentId !== "string") return null;
  if (typeof displayName !== "string" || typeof excerpt !== "string") return null;
  if (!isOffset(startOffset) || !isOffset(endOffset)) return null;
  return { chunkId, documentId, displayName, startOffset, endOffset, excerpt };
}

/** Runtime check of an untrusted body; `null` when it is not exactly an `AnswerResponse`. */
export function parseAnswerResponse(value: unknown): AnswerResponse | null {
  if (!isRecord(value) || typeof value["model"] !== "string") return null;
  const model = value["model"];
  if (value["kind"] === "insufficient_evidence") {
    const reason = value["reason"];
    if (Object.keys(value).length !== 3) return null;
    return reason === "no_evidence" || reason === "not_supported"
      ? { kind: "insufficient_evidence", model, reason }
      : null;
  }
  const { text, citations } = value;
  if (value["kind"] !== "answer" || Object.keys(value).length !== 4) return null;
  if (typeof text !== "string" || !Array.isArray(citations)) return null;
  const parsed = citations.map(parseCitation);
  const valid = parsed.filter((c): c is CitationResponse => c !== null);
  return valid.length === parsed.length ? { kind: "answer", model, text, citations: valid } : null;
}
