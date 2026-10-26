import type { ApiEnv } from "@contextvault/config";
import type { SessionTokenHash, SessionTokens } from "@contextvault/domain";
import { Inject, Injectable } from "@nestjs/common";
import { parse, serialize } from "cookie";
import type { HttpRequest, HttpResponse } from "./http-types";
import { ENV, SESSION_TOKENS } from "./tokens";

const maxAgeSeconds = 7 * 24 * 60 * 60;

// `Secure` and the `__Host-` prefix follow NODE_ENV, never the request scheme or proxy headers.
// Safari ignores Secure cookies on plain http://localhost, hence the plain name outside production.
@Injectable()
export class SessionCookies {
  private readonly secure: boolean;
  readonly name: string;

  constructor(
    @Inject(ENV) env: ApiEnv,
    @Inject(SESSION_TOKENS) private readonly tokens: SessionTokens,
  ) {
    this.secure = env.NODE_ENV === "production";
    this.name = this.secure ? "__Host-cv_session" : "cv_session";
  }

  /** Null for a missing, malformed, or non-token cookie. */
  presentedHash(req: HttpRequest): SessionTokenHash | null {
    const header = req.headers.cookie;
    if (typeof header !== "string") return null;
    const value = parse(header)[this.name];
    return value === undefined ? null : this.tokens.hash(value);
  }

  set(res: HttpResponse, token: string): void {
    res.setHeader("Set-Cookie", this.serialize(token, maxAgeSeconds));
  }

  clear(res: HttpResponse): void {
    res.setHeader("Set-Cookie", this.serialize("", 0));
  }

  private serialize(value: string, maxAge: number): string {
    return serialize(this.name, value, {
      httpOnly: true,
      secure: this.secure,
      sameSite: "lax",
      path: "/",
      maxAge,
    });
  }
}
