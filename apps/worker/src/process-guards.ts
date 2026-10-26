// Fail fast: a process in an unknown state must not keep serving or consuming work.
export function installProcessGuards(): void {
  process.on("unhandledRejection", () => fail("UNHANDLED_REJECTION"));
  process.on("uncaughtException", () => fail("UNCAUGHT_EXCEPTION"));
}

// Logs the code only: error text may carry secrets or document content.
export function fail(code: string): never {
  console.error(JSON.stringify({ level: "error", code }));
  process.exit(1);
}
