import { parseApiErrorBody } from "@contextvault/contracts";

// Browser-side HTTP client for the same-origin `/api/*` path. Credentials are the HttpOnly session
// cookie only: this module never reads, stores or sends a token, and the browser adds `Origin`
// (the API's CSRF check). Every response is `unknown` until a contract parser accepts it.

export class HttpError extends Error {
  override readonly name = "HttpError";

  constructor(
    /** HTTP status; 0 when no response arrived. */
    readonly status: number,
    /** Stable machine code from the API, or a `network.*` / `response.*` client code. */
    readonly code: string,
    readonly requestId: string | null = null,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(code);
  }
}

export interface RequestOptions {
  readonly method?: "GET" | "POST" | "DELETE" | undefined;
  readonly json?: unknown;
  readonly signal?: AbortSignal | undefined;
  /** Injected in unit tests. */
  readonly fetch?: typeof fetch | undefined;
}

function retryAfterOf(res: Response): number | null {
  const value = res.headers.get("retry-after");
  return value !== null && /^\d{1,6}$/.test(value) ? Number(value) : null;
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(res.status, "response.invalid");
  }
}

/** Resolves to the parsed JSON body (`null` for an empty one); throws `HttpError` otherwise. */
export async function request(path: string, options: RequestOptions = {}): Promise<unknown> {
  // Same origin only: an absolute or protocol-relative URL would send the cookie elsewhere.
  if (!path.startsWith("/api/") || path.startsWith("/api//")) {
    throw new Error("request path must be a same-origin /api/ path");
  }
  const send = options.fetch ?? fetch;
  let res: Response;
  try {
    res = await send(path, {
      method: options.method ?? "GET",
      headers:
        options.json === undefined
          ? { accept: "application/json" }
          : { accept: "application/json", "content-type": "application/json" },
      body: options.json === undefined ? null : JSON.stringify(options.json),
      credentials: "same-origin",
      cache: "no-store",
      redirect: "manual",
      signal: options.signal ?? null,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new HttpError(0, "network.unavailable");
  }

  // A manual redirect surfaces as an opaque response with status 0: never follow one.
  if (res.type === "opaqueredirect" || res.status === 0) {
    throw new HttpError(0, "response.invalid");
  }
  if (res.ok) return readJson(res);

  const failure = parseApiErrorBody(await readJson(res).catch(() => null));
  throw new HttpError(
    res.status,
    failure?.code ?? "response.invalid",
    failure?.requestId ?? null,
    retryAfterOf(res),
  );
}

/** Validates an untrusted body with a contract parser; a mismatch is a failed response. */
export function expectShape<T>(body: unknown, parse: (value: unknown) => T | null): T {
  const parsed = parse(body);
  if (parsed === null) throw new HttpError(200, "response.invalid");
  return parsed;
}
