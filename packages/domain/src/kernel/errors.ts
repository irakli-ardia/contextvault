export class DomainError extends Error {
  override readonly name = "DomainError";

  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/**
 * The connection failed after COMMIT was sent, so the work may or may not be durable. It is never
 * proof of a rollback: callers keep whatever the work may have created and report it.
 */
export class TransactionOutcomeUnknown extends DomainError {
  constructor(options?: ErrorOptions) {
    super("transaction.outcome_unknown", "Transaction outcome unknown", options);
  }
}
