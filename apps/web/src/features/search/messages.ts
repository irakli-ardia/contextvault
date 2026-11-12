import { HttpError } from "../../lib/http-client";

const GENERIC = "Something went wrong. Try again.";

/** Guidance for a failed search; unknown codes get a generic line, never the raw code. */
export function searchErrorMessage(error: unknown): string {
  if (!(error instanceof HttpError)) return GENERIC;
  if (error.status === 401) return "Your session ended.";
  if (error.status === 403 || error.status === 404) {
    return "You do not have access to this workspace.";
  }
  if (error.status === 429) {
    const wait = !error.retryAfterSeconds ? "a moment" : `${error.retryAfterSeconds} s`;
    return `Too many searches. Wait ${wait} and try again.`;
  }
  if (error.status === 400) return "Enter a query of 1 to 1000 characters.";
  if (error.code === "embedding.unavailable") {
    return "The embedding service is unavailable. Try again shortly.";
  }
  if (error.code === "network.unavailable") {
    return "Cannot reach the server. Check your connection and try again.";
  }
  return GENERIC;
}

export const isSessionEnded = (error: unknown): boolean =>
  error instanceof HttpError && error.status === 401;
