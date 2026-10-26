import { z } from "zod";

const baseEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
});

export type BaseEnv = z.infer<typeof baseEnvSchema>;

export class EnvError extends Error {
  override readonly name = "EnvError";
}

// Messages carry variable names and Zod's rule text only; Zod does not echo input values.
export function parseEnv(source: Record<string, string | undefined>): BaseEnv {
  const result = baseEnvSchema.safeParse(source);
  if (result.success) return result.data;
  const lines = result.error.issues.map((issue) => `- ${issue.path.join(".")}: ${issue.message}`);
  throw new EnvError(`Invalid environment variables:\n${lines.join("\n")}`);
}

export function loadEnv(): BaseEnv {
  return parseEnv(process.env);
}
