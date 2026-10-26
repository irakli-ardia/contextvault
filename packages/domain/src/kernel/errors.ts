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
