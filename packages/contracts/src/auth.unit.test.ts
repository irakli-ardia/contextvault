import { describe, expect, it } from "vitest";
import { parseApiErrorBody, parseLoginResponse, parseMeResponse } from "./auth";

const user = { id: "u1", email: "a@example.com" };
const workspace = { id: "w1", name: "Home", role: "owner" };

describe("auth response parsers", () => {
  it("accept exactly the documented shapes", () => {
    expect(parseLoginResponse({ user })).toEqual({ user });
    expect(parseMeResponse({ user, workspaces: [workspace] })).toEqual({
      user,
      workspaces: [workspace],
    });
    expect(parseApiErrorBody({ error: { code: "auth.invalid", requestId: "r" } })).toEqual({
      code: "auth.invalid",
      requestId: "r",
    });
  });

  it.each([
    ["null", null],
    ["a string", "ok"],
    ["an array", []],
    ["a missing user", {}],
    ["an extra key", { user, token: "secret" }],
    ["a numeric id", { user: { id: 1, email: "a@example.com" } }],
    ["an extra user key", { user: { ...user, admin: true } }],
  ])("login rejects %s", (_name, body) => {
    expect(parseLoginResponse(body)).toBeNull();
  });

  it.each([
    ["no workspaces key", { user }],
    ["workspaces not an array", { user, workspaces: {} }],
    ["a malformed membership", { user, workspaces: [{ id: "w1", name: "Home" }] }],
    ["an extra key", { user, workspaces: [], extra: 1 }],
  ])("me rejects %s", (_name, body) => {
    expect(parseMeResponse(body)).toBeNull();
  });

  it.each([
    ["a bare error string", { error: "boom" }],
    ["a missing request id", { error: { code: "x" } }],
    ["an extra key", { error: { code: "x", requestId: "r", detail: "leak" } }],
  ])("error body rejects %s", (_name, body) => {
    expect(parseApiErrorBody(body)).toBeNull();
  });
});
