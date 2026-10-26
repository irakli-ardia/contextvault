import { HashingBusy, parsePassword } from "@contextvault/domain";
import { describe, expect, it } from "vitest";
import { createPasswordHasher } from "./password-hasher";
import { currentParams, formatHash, parseHash } from "./phc";

const hasher = createPasswordHasher();
const password = parsePassword("correct horse battery staple");

describe("password hasher", () => {
  it("hashes to a current-parameter PHC string with a fresh salt each time", async () => {
    const [a, b] = await Promise.all([hasher.hash(password), hasher.hash(password)]);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
    expect(a).not.toContain(password);
    expect(parseHash(a)?.salt).toHaveLength(16);
    expect(parseHash(a)?.tag).toHaveLength(32);
    expect(hasher.needsRehash(a)).toBe(false);
  });

  it("verifies the right password and refuses a wrong or near-miss one", async () => {
    const stored = await hasher.hash(password);
    expect(await hasher.verify(password, stored)).toBe(true);
    expect(await hasher.verify(parsePassword("correct horse battery stapl3"), stored)).toBe(false);
    expect(await hasher.verify(parsePassword("CORRECT HORSE BATTERY STAPLE"), stored)).toBe(false);
  });

  it("verifies hashes made with older, cheaper parameters and asks for a rehash", async () => {
    const weak = { memoryKiB: 64, passes: 1, parallelism: 1 };
    const stored = await hasher.hash(password);
    const parsed = parseHash(stored);
    if (parsed === null) throw new Error("setup");
    const { derive } = await import("./argon2");
    const tag = await derive(Buffer.from(password), parsed.salt, weak, 32);
    const old = formatHash(weak, parsed.salt, tag);
    expect(await hasher.verify(password, old)).toBe(true);
    expect(hasher.needsRehash(old)).toBe(true);
  });

  it.each([
    "",
    "plaintext",
    "$argon2i$v=19$m=65536,t=3,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    `$argon2id$v=19$m=4294967295,t=3,p=1$AAAAAAAAAAAAAAAAAAAAAA$${"A".repeat(43)}`,
    formatHash({ ...currentParams, memoryKiB: 262_145 }, Buffer.alloc(16), Buffer.alloc(32)),
    formatHash({ ...currentParams, passes: 11 }, Buffer.alloc(16), Buffer.alloc(32)),
  ])("rejects malformed or unsafe stored hash %#", async (stored) => {
    const started = performance.now();
    expect(await hasher.verify(password, stored)).toBe(false);
    expect(hasher.needsRehash(stored)).toBe(false);
    // Rejected during parsing: no 64 MiB-and-up derivation was attempted.
    expect(performance.now() - started).toBeLessThan(50);
  });

  it("is a bounded queue: concurrency 1, no waiting room, second call is refused", async () => {
    const tight = createPasswordHasher({ concurrency: 1, maxQueue: 0 });
    const first = tight.hash(password);
    await expect(tight.hash(password)).rejects.toBeInstanceOf(HashingBusy);
    await first;
  });

  it("never echoes password or hash in a thrown error", async () => {
    const tight = createPasswordHasher({ concurrency: 1, maxQueue: 0 });
    const first = tight.hash(password);
    const error = await tight.verify(password, "x").then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeNull();
    const busy = await tight.hash(password).catch((e: unknown) => String(e));
    expect(busy).not.toContain(password);
    await first;
  });
});
