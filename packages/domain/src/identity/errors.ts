import { DomainError } from "../kernel/errors";

// Hashing capacity is exhausted: the caller answers 429 instead of queueing without bound.
export class HashingBusy extends DomainError {
  constructor() {
    super("auth.busy", "Password hashing capacity exhausted");
  }
}
