import { DomainError } from "../kernel/errors";

export type Email = string & { readonly brand: "Email" };

// Printable ASCII only, one "@": the database check `email = lower(email)` and the login proof
// compare by equality, so a Unicode case mapping must never decide which account matches.
const emailPattern = /^[!-?A-~]+@[!-?A-~]+\.[!-?A-~]+$/;
const maxLength = 254;

const isEmail = (value: string): value is Email =>
  value.length <= maxLength && emailPattern.test(value);

export function parseEmail(value: string): Email {
  const normalized = value.trim().toLowerCase();
  if (!isEmail(normalized)) throw new DomainError("email.invalid", "Invalid email address");
  return normalized;
}
