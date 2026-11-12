import { HttpError } from "../../../lib/http-client";

/** User-facing text for a failed login. One message for any credential failure: no oracle. */
export function loginErrorMessage(error: unknown): string {
  if (!(error instanceof HttpError)) return "Something went wrong. Try again.";
  if (error.status === 401) return "Email or password is incorrect.";
  if (error.status === 429) {
    const wait = error.retryAfterSeconds;
    return wait === null
      ? "Too many attempts. Try again later."
      : `Too many attempts. Try again in ${wait} second${wait === 1 ? "" : "s"}.`;
  }
  if (error.status === 400) return "Enter a valid email address and password.";
  if (error.code === "network.unavailable") return "Can't reach the server. Check your connection.";
  return "Sign-in is unavailable right now. Try again in a moment.";
}
