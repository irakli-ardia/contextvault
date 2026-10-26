import * as nodeCrypto from "node:crypto";
import { type Argon2Params, tagBytes } from "./phc";

// `import *` rather than a named import: a runtime without crypto.argon2 (Node before 24.7)
// would fail at link time with an unreadable error instead of reaching `assertArgon2Runtime`.
export const argon2Available = (): boolean => typeof nodeCrypto.argon2 === "function";

export function derive(
  message: Buffer,
  salt: Buffer,
  params: Argon2Params,
  tagLength: number = tagBytes,
  extra: { secret?: Buffer; associatedData?: Buffer } = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeCrypto.argon2(
      "argon2id",
      {
        message,
        nonce: salt,
        memory: params.memoryKiB,
        passes: params.passes,
        parallelism: params.parallelism,
        tagLength,
        ...extra,
      },
      // The driver error is dropped on purpose: nothing derived from a password may escape.
      (error, tag) => (error === null ? resolve(tag) : reject(new Error("Argon2 failed"))),
    );
  });
}
