import { DomainError } from "@contextvault/domain";

export class AccountExists extends DomainError {
  constructor() {
    super("account.exists", "An account with that email already exists");
  }
}

// Also the answer for a user whose creation was interrupted before its credential was written:
// rerunning user:create completes it.
export class AccountNotFound extends DomainError {
  constructor() {
    super(
      "account.not_found",
      "No account with a password exists for that email (if creation was interrupted, rerun user:create)",
    );
  }
}

export class PasswordMismatch extends DomainError {
  constructor() {
    super("password.mismatch", "The two passwords do not match");
  }
}

export class NotInteractive extends DomainError {
  constructor() {
    super(
      "input.not_interactive",
      "Passwords are read only from an interactive terminal; there is no stdin or environment fallback",
    );
  }
}

export class InputAborted extends DomainError {
  constructor() {
    super("input.aborted", "Aborted");
  }
}
