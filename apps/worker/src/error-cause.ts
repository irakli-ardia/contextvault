// Word characters, with single dots between segments for domain codes (transaction.outcome_unknown).
const safe = /^(?!.{41})\w+(\.\w+)*$/;

// A short, loggable label for an error: its class name plus the first `code` found on it or on a
// nested cause (the driver's, e.g. ECONNREFUSED or a SQLSTATE). Never the message, which can carry
// connection strings, SQL or document content.
export function errorCause(error: unknown): string {
  const name = error instanceof Error && safe.test(error.name) ? error.name : "UnknownError";
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current instanceof Error; depth += 1) {
    const code = "code" in current ? current.code : undefined;
    if (typeof code === "string" && safe.test(code)) return `${name}:${code}`;
    current = current.cause;
  }
  return name;
}
