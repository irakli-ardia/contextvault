import { loadWebEnv } from "@contextvault/config";
import { type MeResponse, parseMeResponse } from "@contextvault/contracts";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

/**
 * The caller's profile as the API sees it, or `null` without a live session. Authoritative: the
 * API checks the session row, this only forwards the browser's cookie. Throws if the API is
 * unreachable or answers off-contract, so a fault never reads as "signed out".
 */
export async function getServerSession(): Promise<MeResponse | null> {
  const cookie = (await cookies()).toString();
  if (cookie === "") return null;
  const res = await fetch(`${loadWebEnv().API_INTERNAL_URL}/auth/me`, {
    headers: { cookie, accept: "application/json" },
    cache: "no-store",
    redirect: "manual",
  });
  if (res.status === 401) return null;
  const session = res.ok ? parseMeResponse(await res.json().catch(() => null)) : null;
  if (session === null) throw new Error("session.unavailable");
  return session;
}

/** For protected pages. Call it in the page itself: layouts do not re-render on navigation. */
export async function requireSession(): Promise<MeResponse> {
  const session = await getServerSession();
  if (session === null) redirect("/login");
  return session;
}
