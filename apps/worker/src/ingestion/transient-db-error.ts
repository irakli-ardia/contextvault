// SQLSTATE classes and codes that say "try again later", not "this request is wrong":
// 08 connection exception, 53 insufficient resources (incl. too many connections), 57P01-03
// shutdown / cannot connect now, 40001 serialization, 40P01 deadlock, 55P03 lock not available,
// 57014 cancelled (statement timeout).
const transientSqlState = /^(08|53)|^(57P0[123]|40001|40P01|55P03|57014)$/;
const transientSocket = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ENOTFOUND",
]);
// The pg client's own errors carry no code; these are its fixed texts, not user or document data.
const transientMessage = /^(Connection terminated|timeout exceeded when trying to connect)/;

// Drizzle wraps the driver error as `cause`, so the whole chain is read, bounded.
export function isTransientDbError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const code = "code" in current ? current.code : undefined;
    if (typeof code === "string" && (transientSqlState.test(code) || transientSocket.has(code))) {
      return true;
    }
    if (transientMessage.test(current.message)) return true;
    current = current.cause;
  }
  return false;
}
