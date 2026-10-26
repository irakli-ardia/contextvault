import { DomainError } from "../kernel/errors";

export type Password = string & { readonly brand: "Password" };

export const passwordLength = { min: 12, max: 128 } as const;
// NFKC can expand a string; refuse absurd input before normalizing it.
const maxRawLength = 1024;

const isPassword = (value: string): value is Password => {
  // Counted in code points, not UTF-16 units, so an emoji is one character.
  const length = Array.from(value).length;
  return length >= passwordLength.min && length <= passwordLength.max;
};

// The error never carries the value.
export function parsePassword(raw: string): Password {
  const normalized = raw.length > maxRawLength ? "" : raw.normalize("NFKC");
  if (!isPassword(normalized)) {
    throw new DomainError(
      "password.invalid",
      `Password must be ${passwordLength.min}-${passwordLength.max} characters`,
    );
  }
  return normalized;
}
