import {
  type LoginResponse,
  type MeResponse,
  parseLoginResponse,
  parseMeResponse,
} from "@contextvault/contracts";
import { expectShape, HttpError, request } from "../../lib/http-client";

export interface Credentials {
  readonly email: string;
  readonly password: string;
}

export async function login(credentials: Credentials): Promise<LoginResponse> {
  const body = await request("/api/auth/login", { method: "POST", json: credentials });
  return expectShape(body, parseLoginResponse);
}

export async function logout(): Promise<void> {
  await request("/api/auth/logout", { method: "POST" });
}

/** The signed-in profile, or `null` when there is no live session (a 401 is an answer, not a fault). */
export async function fetchSession(signal?: AbortSignal): Promise<MeResponse | null> {
  try {
    return expectShape(await request("/api/auth/me", { signal }), parseMeResponse);
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) return null;
    throw error;
  }
}
