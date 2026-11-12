import { parseSearchResponse, type SearchMode, type SearchResponse } from "@contextvault/contracts";
import { expectShape, request } from "../../lib/http-client";

export type ModeOutcome =
  | { readonly mode: SearchMode; readonly ok: true; readonly response: SearchResponse }
  | { readonly mode: SearchMode; readonly ok: false; readonly error: unknown };

export async function searchWorkspace(
  workspaceId: string,
  query: string,
  mode: SearchMode,
  signal?: AbortSignal,
): Promise<SearchResponse> {
  const path = `/api/workspaces/${encodeURIComponent(workspaceId)}/search`;
  return expectShape(
    await request(path, { method: "POST", json: { query, mode }, signal }),
    parseSearchResponse,
  );
}

/** One independent request per mode, so a failure in one mode never hides the others. */
export function searchModes(
  workspaceId: string,
  query: string,
  modes: readonly SearchMode[],
): Promise<ModeOutcome[]> {
  return Promise.all(
    modes.map(async (mode): Promise<ModeOutcome> => {
      try {
        return { mode, ok: true, response: await searchWorkspace(workspaceId, query, mode) };
      } catch (error) {
        return { mode, ok: false, error };
      }
    }),
  );
}
