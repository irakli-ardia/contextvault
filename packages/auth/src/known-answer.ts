import { timingSafeEqual } from "node:crypto";
import { argon2Available, derive } from "./argon2";

// RFC 9106 section 5.3 (Argon2id): p=4, m=32 KiB, t=3, with secret and associated data.
export const rfc9106Argon2id = {
  message: Buffer.alloc(32, 1),
  salt: Buffer.alloc(16, 2),
  secret: Buffer.alloc(8, 3),
  associatedData: Buffer.alloc(12, 4),
  params: { memoryKiB: 32, passes: 3, parallelism: 4 },
  tag: Buffer.from("0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659", "hex"),
} as const;

// Cheap (32 KiB): meant for boot. Fails closed when the runtime lacks Argon2 or computes it wrong.
export async function assertArgon2Runtime(): Promise<void> {
  if (!argon2Available()) throw new Error("crypto.argon2 is unavailable on this Node runtime");
  const v = rfc9106Argon2id;
  const tag = await derive(v.message, v.salt, v.params, v.tag.length, {
    secret: v.secret,
    associatedData: v.associatedData,
  });
  if (!timingSafeEqual(tag, v.tag)) throw new Error("crypto.argon2 failed the RFC 9106 vector");
}
