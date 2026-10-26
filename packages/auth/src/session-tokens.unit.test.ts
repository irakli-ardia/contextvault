import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSessionTokens } from "./session-tokens";

const tokens = createSessionTokens();

describe("session tokens", () => {
  it("generates unpredictable 256-bit base64url tokens", () => {
    const batch = Array.from({ length: 200 }, () => tokens.generate());
    expect(new Set(batch.map((b) => b.token)).size).toBe(200);
    for (const { token } of batch) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(batch[0]?.token ?? "", "base64url")).toHaveLength(32);
  });

  it("hashes with SHA-256 to lowercase hex, and the hash differs from the token", () => {
    const { token, hash } = tokens.generate();
    expect(hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
    expect(tokens.hash(token)).toBe(hash);
  });

  it.each([
    "",
    "short",
    "a".repeat(42),
    "a".repeat(44),
    `${"a".repeat(42)}=`,
    `${"a".repeat(42)}!`,
    `${"a".repeat(42)}\n`,
    "a b".padEnd(43, "a"),
  ])("refuses to hash malformed candidate %j", (candidate) => {
    expect(tokens.hash(candidate)).toBeNull();
  });
});
