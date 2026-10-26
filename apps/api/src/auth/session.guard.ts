import { resolveSession, type SessionDeps } from "@contextvault/domain";
import { type CanActivate, type ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { HttpRequest } from "./http-types";
import { isPublicKey } from "./public.decorator";
import { bindIdentity } from "./request-state";
import { SessionCookies } from "./session-cookies";
import { SESSION_DEPS } from "./tokens";

// Default deny. The identity is built from the stored session row only.
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SessionCookies) private readonly cookies: SessionCookies,
    @Inject(SESSION_DEPS) private readonly deps: SessionDeps,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(isPublicKey, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;
    const req = context.switchToHttp().getRequest<HttpRequest>();
    bindIdentity(req, await resolveSession(this.deps, this.cookies.presentedHash(req)));
    return true;
  }
}
