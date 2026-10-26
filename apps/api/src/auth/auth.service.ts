import { createHash } from "node:crypto";
import {
  HashingBusy,
  InvalidCredentials,
  type LoginDeps,
  login,
  logout,
  type SessionDeps,
  type SessionTokenHash,
  type User,
} from "@contextvault/domain";
import { Inject, Injectable } from "@nestjs/common";
import { ApiError } from "./api-error";
import { accountPolicy, ipPolicy, LoginLimiter } from "./login-limiter";
import { LOGIN_DEPS, SESSION_DEPS } from "./tokens";

const throttled = (seconds: number) =>
  new ApiError(429, "auth.throttled", { "Retry-After": String(seconds) });

// Application service: throttling around the login use case. Knows nothing about HTTP.
@Injectable()
export class AuthService {
  private readonly limiter = new LoginLimiter();

  constructor(
    @Inject(LOGIN_DEPS) private readonly loginDeps: LoginDeps,
    @Inject(SESSION_DEPS) private readonly sessionDeps: SessionDeps,
  ) {}

  async login(input: {
    email: string;
    password: string;
    ip: string;
    presentedTokenHash: SessionTokenHash | null;
  }): Promise<{ user: User; token: string }> {
    // The account key hashes the email so it is bounded and never logged; it does not depend on
    // any header, so a spoofed address cannot dodge it.
    const keys = [
      `ip:${input.ip}`,
      `acct:${createHash("sha256").update(input.email.trim().toLowerCase()).digest("hex")}`,
    ] as const;
    const now = () => this.loginDeps.now().getTime();
    const wait = this.limiter.retryAfterSeconds(keys, now());
    if (wait !== null) throw throttled(wait);
    try {
      const result = await login(this.loginDeps, {
        email: input.email,
        password: input.password,
        presentedTokenHash: input.presentedTokenHash,
      });
      this.limiter.clear(keys[1]);
      return result;
    } catch (error) {
      // Same body as any other throttle: the hash queue being full is not an oracle either.
      if (error instanceof HashingBusy) throw throttled(1);
      if (error instanceof InvalidCredentials) {
        this.limiter.recordFailure(keys[0], ipPolicy, now());
        this.limiter.recordFailure(keys[1], accountPolicy, now());
      }
      throw error;
    }
  }

  logout(tokenHash: SessionTokenHash | null): Promise<void> {
    return logout(this.sessionDeps, tokenHash);
  }
}
