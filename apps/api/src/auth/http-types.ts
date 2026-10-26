// The slice of the Express request and response the auth layer reads or writes. Declared here so
// the app needs no direct Express dependency; Nest hands the real objects to the guards.
export interface HttpRequest {
  readonly method: string;
  readonly headers: { readonly origin?: string | string[]; readonly cookie?: string | string[] };
  readonly params: { readonly workspaceId?: string };
  /** Derived by Express from the socket and `trust proxy`; the only client address used. */
  readonly ip: string | undefined;
}

export interface HttpResponse {
  setHeader(name: string, value: string | readonly string[]): unknown;
}
