// Drizzle wraps driver errors; the SQLSTATE lives on the wrapped pg error.
export function postgresErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current instanceof Error; depth++) {
    if ("code" in current && typeof current.code === "string") return current.code;
    current = current.cause;
  }
  return undefined;
}
