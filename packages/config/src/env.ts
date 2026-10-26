import { z } from "zod";

export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
});

export type BaseEnv = z.infer<typeof baseEnvSchema>;
