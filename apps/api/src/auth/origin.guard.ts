import type { ApiEnv } from "@contextvault/config";
import { type CanActivate, type ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { ApiError } from "./api-error";
import type { HttpRequest } from "./http-types";
import { ENV } from "./tokens";

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

// CSRF defence for cookie auth: every state-changing request, login included, must carry an
// Origin exactly equal to the configured web origin. Reads only Origin and the configured value,
// never Host or X-Forwarded-*, so a spoofed forwarded header cannot change the outcome.
@Injectable()
export class OriginGuard implements CanActivate {
  constructor(@Inject(ENV) private readonly env: ApiEnv) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<HttpRequest>();
    if (safeMethods.has(req.method)) return true;
    if (req.headers.origin !== this.env.WEB_ORIGIN) {
      throw new ApiError(403, "request.forbidden_origin");
    }
    return true;
  }
}
