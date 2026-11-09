// A transport-level refusal with a stable code; domain errors are mapped in the error filter.
export class ApiError extends Error {
  override readonly name = "ApiError";

  constructor(
    readonly status: number,
    readonly code: string,
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super(code);
  }
}
