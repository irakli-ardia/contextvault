import { describe, expect, it } from "vitest";
import { currentParams, formatHash, isBelowCurrent, parseHash } from "./phc";

const salt = Buffer.alloc(16, 5);
const tag = Buffer.alloc(32, 9);
const good = formatHash(currentParams, salt, tag);
const s = salt.toString("base64").replace(/=+$/, "");
const t = tag.toString("base64").replace(/=+$/, "");

describe("PHC encoding", () => {
  it("is the versioned argon2id format and round-trips", () => {
    expect(good).toBe(`$argon2id$v=19$m=65536,t=3,p=1$${s}$${t}`);
    const parsed = parseHash(good);
    expect(parsed?.params).toEqual(currentParams);
    expect(parsed?.salt.equals(salt)).toBe(true);
    expect(parsed?.tag.equals(tag)).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["other algorithm", good.replace("argon2id", "argon2i")],
    ["scrypt-looking", "$scrypt$ln=17,r=8,p=1$c2FsdA$aGFzaA"],
    ["other version", good.replace("v=19", "v=16")],
    ["no version", good.replace("v=19$", "")],
    ["reordered params", good.replace("m=65536,t=3,p=1", "t=3,m=65536,p=1")],
    ["leading zero", good.replace("m=65536", "m=065536")],
    ["zero passes", good.replace("t=3", "t=0")],
    ["zero lanes", good.replace("p=1", "p=0")],
    ["too many lanes", good.replace("p=1", "p=5")],
    ["too many passes", good.replace("t=3", "t=11")],
    ["memory above 256 MiB", good.replace("m=65536", "m=262145")],
    ["memory huge", good.replace("m=65536", "m=999999")],
    ["memory below 8 per lane", good.replace("m=65536,t=3,p=1", "m=15,t=3,p=2")],
    ["negative", good.replace("t=3", "t=-3")],
    ["padded base64", good.replace(`$${s}$`, `$${salt.toString("base64")}A=$`)],
    ["non-canonical base64", good.replace(`$${t}`, `$${t.slice(0, -1)}l`)],
    ["short salt", formatHash(currentParams, Buffer.alloc(4), tag)],
    ["short tag", formatHash(currentParams, salt, Buffer.alloc(8))],
    ["oversize salt", formatHash(currentParams, Buffer.alloc(65), tag)],
    ["trailing data", `${good}$extra`],
    ["trailing newline", `${good}\n`],
    ["huge", `${good}${"A".repeat(1000)}`],
  ])("rejects %s", (_name, encoded) => {
    expect(parseHash(encoded)).toBeNull();
  });

  it("accepts the largest allowed parameters", () => {
    const max = { memoryKiB: 262_144, passes: 10, parallelism: 4 };
    expect(parseHash(formatHash(max, salt, tag))?.params).toEqual(max);
  });

  it("flags only weaker memory or passes as below current", () => {
    expect(isBelowCurrent(currentParams)).toBe(false);
    expect(isBelowCurrent({ ...currentParams, memoryKiB: 19_456 })).toBe(true);
    expect(isBelowCurrent({ ...currentParams, passes: 2 })).toBe(true);
    expect(isBelowCurrent({ ...currentParams, passes: 4 })).toBe(false);
  });
});
