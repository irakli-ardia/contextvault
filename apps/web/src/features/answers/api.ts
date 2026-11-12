import { type AnswerResponse, parseAnswerResponse } from "@contextvault/contracts";
import { expectShape, request } from "../../lib/http-client";

export async function askQuestion(
  workspaceId: string,
  question: string,
  signal?: AbortSignal,
): Promise<AnswerResponse> {
  const path = `/api/workspaces/${encodeURIComponent(workspaceId)}/answers`;
  return expectShape(
    await request(path, { method: "POST", json: { question }, signal }),
    parseAnswerResponse,
  );
}
