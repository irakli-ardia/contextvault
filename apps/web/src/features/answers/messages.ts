import { HttpError } from "../../lib/http-client";

/** Guidance for a failed question; unknown codes get a generic line, never the raw code. */
export function askErrorMessage(error: unknown): string {
  if (!(error instanceof HttpError)) return "Something went wrong. Try again.";
  if (error.status === 401) return "Your session ended. Sign in again.";
  if (error.code === "answer.throttled") {
    const wait = error.retryAfterSeconds === null ? "a moment" : `${error.retryAfterSeconds} s`;
    return `Too many questions. Wait ${wait} and try again.`;
  }
  if (error.code === "search.invalid") return "Ask a question of 1 to 1000 characters.";
  if (error.code === "answer.unavailable" || error.code === "embedding.unavailable") {
    return "The answer service is unavailable. Try again shortly.";
  }
  return "Something went wrong. Try again.";
}
