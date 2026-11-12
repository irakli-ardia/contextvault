// Response shapes of POST /auth/login, GET /auth/me and the API's error body. Parsers take
// `unknown` and return `null` for anything that is not exactly the documented shape.

export interface UserResponse {
  readonly id: string;
  readonly email: string;
}

export interface LoginResponse {
  readonly user: UserResponse;
}

export interface WorkspaceMembership {
  readonly id: string;
  readonly name: string;
  readonly role: string;
}

export interface MeResponse {
  readonly user: UserResponse;
  readonly workspaces: readonly WorkspaceMembership[];
}

export interface ApiErrorBody {
  readonly code: string;
  readonly requestId: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const hasKeys = (value: Record<string, unknown>, count: number) =>
  Object.keys(value).length === count;

function parseUser(value: unknown): UserResponse | null {
  if (!isRecord(value) || !hasKeys(value, 2)) return null;
  const { id, email } = value;
  return typeof id === "string" && typeof email === "string" ? { id, email } : null;
}

function parseMembership(value: unknown): WorkspaceMembership | null {
  if (!isRecord(value) || !hasKeys(value, 3)) return null;
  const { id, name, role } = value;
  if (typeof id !== "string" || typeof name !== "string" || typeof role !== "string") return null;
  return { id, name, role };
}

export function parseLoginResponse(value: unknown): LoginResponse | null {
  if (!isRecord(value) || !hasKeys(value, 1)) return null;
  const user = parseUser(value["user"]);
  return user && { user };
}

export function parseMeResponse(value: unknown): MeResponse | null {
  if (!isRecord(value) || !hasKeys(value, 2) || !Array.isArray(value["workspaces"])) return null;
  const user = parseUser(value["user"]);
  if (user === null) return null;
  const workspaces: WorkspaceMembership[] = [];
  for (const item of value["workspaces"]) {
    const membership = parseMembership(item);
    if (membership === null) return null;
    workspaces.push(membership);
  }
  return { user, workspaces };
}

/** `{ error: { code, requestId } }`, as the API and the upload route handler send it. */
export function parseApiErrorBody(value: unknown): ApiErrorBody | null {
  if (!isRecord(value) || !hasKeys(value, 1)) return null;
  const error = value["error"];
  if (!isRecord(error) || !hasKeys(error, 2)) return null;
  const { code, requestId } = error;
  return typeof code === "string" && typeof requestId === "string" ? { code, requestId } : null;
}
