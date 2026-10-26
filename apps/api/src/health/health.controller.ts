import { Controller, Get } from "@nestjs/common";
import { Public } from "../auth/public.decorator";

export type HealthResponse = { status: "ok" };

@Controller("health")
export class HealthController {
  @Public()
  @Get()
  check(): HealthResponse {
    return { status: "ok" };
  }
}
