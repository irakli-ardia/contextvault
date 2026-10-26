import { DomainError } from "../kernel/errors";

// Hashing capacity is exhausted: the caller answers 429 instead of queueing without bound.
export class HashingBusy extends DomainError {
  constructor() {
    super("auth.busy", "Password hashing capacity exhausted");
  }
}

// One error for an unknown email, a wrong password, and a malformed credential: no oracle.
export class InvalidCredentials extends DomainError {
  constructor() {
    super("auth.invalid_credentials", "Invalid email or password");
  }
}

// No session, or one that is malformed, unknown, revoked, expired, or idle.
export class Unauthenticated extends DomainError {
  constructor() {
    super("auth.unauthenticated", "Authentication required");
  }
}
