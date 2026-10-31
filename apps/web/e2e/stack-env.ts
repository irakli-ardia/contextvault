import { readFileSync } from "node:fs";

// The one place E2E code reads the verified stack. scripts/checks/with-test-stack.mjs sets
// CV_TEST_STACK_VERIFIED after its checks and injects the values; the flag is a launch convention,
// not a credential (a shell can forge it). The guarantees live in the wrapper's endpoint checks
// and PostgreSQL identity marker. This module only makes a bare `playwright test` fail before
// anything starts, and keeps the API port in one derived place.
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const DEV_API_PORT = "3001";

// biome-ignore lint/style/noProcessEnv: the verified stack's values are injected, never read from a file
const env = process.env;

/** A value injected by the wrapper; throws when the run was not launched through it. */
export function verifiedValue(name: string): string {
  const { [name]: value, CV_TEST_STACK_VERIFIED: verified } = env;
  if (verified !== "1" || !value) {
    throw new Error(
      `${name} is not set by a verified stack: run through scripts/checks/with-test-stack.mjs`,
    );
  }
  return value;
}

/** The API endpoint of the verified stack; API_PORT and API_INTERNAL_URL must agree and not be the development API. */
export function verifiedApi(): { port: string; origin: string } {
  const port = verifiedValue("API_PORT");
  const origin = verifiedValue("API_INTERNAL_URL");
  if (!/^[1-9]\d{0,4}$/.test(port) || Number(port) > 65535) throw new Error("API_PORT is invalid");
  if (port === DEV_API_PORT) throw new Error("API_PORT is the development API port");
  if (!URL.canParse(origin)) throw new Error("API_INTERNAL_URL is malformed");
  const url = new URL(origin);
  if (url.origin !== origin || url.protocol !== "http:" || !LOOPBACK.has(url.hostname)) {
    throw new Error("API_INTERNAL_URL must be a bare loopback http origin");
  }
  if (url.port !== port) throw new Error("API_PORT and API_INTERNAL_URL disagree");
  return { port, origin };
}

/** Fails when the web build froze a different API origin into its `/api/*` rewrite (ADR 0009). */
export function assertBuiltFor(origin: string, manifest = "apps/web/.next/routes-manifest.json") {
  let destinations: string[];
  try {
    const { rewrites } = JSON.parse(readFileSync(manifest, "utf8"));
    destinations = rewrites.fallback.map((rule: { destination: string }) => rule.destination);
  } catch {
    throw new Error("web build not found: build with the verified stack's API_INTERNAL_URL");
  }
  if (destinations.length === 0 || destinations.some((d) => !d.startsWith(`${origin}/`))) {
    throw new Error("web build targets a different API origin: rebuild through the wrapper");
  }
}

const ESCAPES: Record<string, string> = { "\n": "\\n", "\r": "\\r", "\t": "\\t", "\v": "\\v" };
/** Escapes a value for a double-quoted curl config string (backslash, quote, control characters). */
export const curlQuote = (value: string): string =>
  value.replace(/[\\"\n\r\t\v]/g, (c) => ESCAPES[c] ?? `\\${c}`);
