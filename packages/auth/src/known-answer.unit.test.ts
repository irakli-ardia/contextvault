import { describe, expect, it } from "vitest";
import { derive } from "./argon2";
import { assertArgon2Runtime, rfc9106Argon2id as vector } from "./known-answer";

describe("RFC 9106 known answers", () => {
  it("Argon2id (section 5.3) matches", async () => {
    const tag = await derive(vector.message, vector.salt, vector.params, 32, {
      secret: vector.secret,
      associatedData: vector.associatedData,
    });
    expect(tag.toString("hex")).toBe(vector.tag.toString("hex"));
  });

  it("the boot check passes on this runtime", async () => {
    await expect(assertArgon2Runtime()).resolves.toBeUndefined();
  });

  it("pins parameter semantics: memory is KiB, passes is t", async () => {
    const message = Buffer.from("password");
    const salt = Buffer.alloc(16, 7);
    const base = { memoryKiB: 64, passes: 2, parallelism: 1 };
    const a = await derive(message, salt, base);
    expect((await derive(message, salt, base)).equals(a)).toBe(true);
    expect((await derive(message, salt, { ...base, passes: 3 })).equals(a)).toBe(false);
    expect((await derive(message, salt, { ...base, memoryKiB: 128 })).equals(a)).toBe(false);
  });
});
