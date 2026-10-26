// PHC string for Argon2id: $argon2id$v=19$m=<KiB>,t=<passes>,p=<lanes>$<salt>$<tag>, with
// unpadded standard base64. The encoding is canonical: one string per (params, salt, tag), so
// anything else (other algorithm or version, reordered or padded fields, non-canonical base64,
// leading zeros) is rejected rather than interpreted.

export interface Argon2Params {
  readonly memoryKiB: number;
  readonly passes: number;
  readonly parallelism: number;
}

export interface ParsedHash {
  readonly params: Argon2Params;
  readonly salt: Buffer;
  readonly tag: Buffer;
}

export const currentParams: Argon2Params = { memoryKiB: 65_536, passes: 3, parallelism: 1 };
export const saltBytes = 16;
export const tagBytes = 32;

// Stored parameters are attacker-influenced input to an allocation: they are bounded before any
// memory is requested.
const bounds = {
  maxMemoryKiB: 262_144,
  maxPasses: 10,
  maxParallelism: 4,
  salt: { min: 8, max: 64 },
  tag: { min: 16, max: 64 },
  maxEncodedLength: 256,
} as const;

const shape =
  /^\$argon2id\$v=19\$m=([1-9]\d{0,5}),t=([1-9]\d?),p=([1-9])\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

const encode = (bytes: Buffer): string => bytes.toString("base64").replace(/=+$/, "");

function decode(text: string, size: { min: number; max: number }): Buffer | null {
  const bytes = Buffer.from(text, "base64");
  const inRange = bytes.length >= size.min && bytes.length <= size.max;
  return inRange && encode(bytes) === text ? bytes : null;
}

export function formatHash(params: Argon2Params, salt: Buffer, tag: Buffer): string {
  const { memoryKiB: m, passes: t, parallelism: p } = params;
  return `$argon2id$v=19$m=${m},t=${t},p=${p}$${encode(salt)}$${encode(tag)}`;
}

export function parseHash(encoded: string): ParsedHash | null {
  if (encoded.length > bounds.maxEncodedLength) return null;
  const match = shape.exec(encoded);
  if (match === null) return null;
  const [, m = "", t = "", p = "", saltText = "", tagText = ""] = match;
  const params = { memoryKiB: Number(m), passes: Number(t), parallelism: Number(p) };
  if (
    params.memoryKiB > bounds.maxMemoryKiB ||
    params.memoryKiB < 8 * params.parallelism ||
    params.passes > bounds.maxPasses ||
    params.parallelism > bounds.maxParallelism
  ) {
    return null;
  }
  const salt = decode(saltText, bounds.salt);
  const tag = decode(tagText, bounds.tag);
  return salt === null || tag === null ? null : { params, salt, tag };
}

export const isBelowCurrent = (params: Argon2Params): boolean =>
  params.memoryKiB < currentParams.memoryKiB || params.passes < currentParams.passes;
