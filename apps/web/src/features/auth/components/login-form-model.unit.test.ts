import { describe, expect, it } from "vitest";
import { HttpError } from "../../../lib/http-client";
import { loginErrorMessage } from "./login-form-model";

describe("loginErrorMessage", () => {
  it.each([
    [new HttpError(401, "auth.invalid_credentials"), "Email or password is incorrect."],
    [new HttpError(429, "auth.throttled", null, 1), "Too many attempts. Try again in 1 second."],
    [new HttpError(429, "auth.throttled", null, 30), "Too many attempts. Try again in 30 seconds."],
    [new HttpError(429, "auth.throttled"), "Too many attempts. Try again later."],
    [new HttpError(0, "network.unavailable"), "Can't reach the server. Check your connection."],
    [
      new HttpError(502, "response.invalid"),
      "Sign-in is unavailable right now. Try again in a moment.",
    ],
    [new Error("boom"), "Something went wrong. Try again."],
  ])("%#", (error, message) => {
    expect(loginErrorMessage(error)).toBe(message);
  });
});
