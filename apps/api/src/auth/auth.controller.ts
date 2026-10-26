import type { Persistence } from "@contextvault/db";
import { getProfile, type Identity, type Profile } from "@contextvault/domain";
import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from "@nestjs/common";
import { z } from "zod";
import { ApiError } from "./api-error";
import { AuthService } from "./auth.service";
import type { HttpRequest, HttpResponse } from "./http-types";
import { Public } from "./public.decorator";
import { CurrentIdentity } from "./request-state";
import { SessionCookies } from "./session-cookies";
import { PERSISTENCE } from "./tokens";

// Strict: a stray `userId` or any unknown key is a 400, never silently used.
const loginBody = z.strictObject({ email: z.string().max(320), password: z.string().max(1024) });

@Controller("auth")
export class AuthController {
  private readonly uow: Persistence["unitOfWork"];

  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(SessionCookies) private readonly cookies: SessionCookies,
    @Inject(PERSISTENCE) persistence: Persistence,
  ) {
    this.uow = persistence.unitOfWork;
  }

  @Public()
  @Post("login")
  @HttpCode(200)
  async login(
    @Body() body: unknown,
    @Req() req: HttpRequest,
    @Res({ passthrough: true }) res: HttpResponse,
  ): Promise<{ user: { id: string; email: string } }> {
    const parsed = loginBody.safeParse(body);
    if (!parsed.success) throw new ApiError(400, "request.invalid");
    const { user, token } = await this.auth.login({
      ...parsed.data,
      // Express derives `ip` from the socket and `trust proxy`; "unknown" shares one bucket.
      ip: req.ip ?? "unknown",
      presentedTokenHash: this.cookies.presentedHash(req),
    });
    this.cookies.set(res, token);
    return { user: { id: user.id, email: user.email } };
  }

  // Session optional and always 204: no oracle for whether the token was live.
  @Public()
  @Post("logout")
  @HttpCode(204)
  async logout(
    @Req() req: HttpRequest,
    @Res({ passthrough: true }) res: HttpResponse,
  ): Promise<void> {
    await this.auth.logout(this.cookies.presentedHash(req));
    this.cookies.clear(res);
  }

  @Get("me")
  async me(@CurrentIdentity() identity: Identity): Promise<{
    user: Profile["user"];
    workspaces: { id: string; name: string; role: string }[];
  }> {
    const profile = await getProfile(this.uow, identity.userId);
    return {
      user: profile.user,
      workspaces: profile.workspaces.map(({ id, name, role }) => ({ id, name, role })),
    };
  }
}
