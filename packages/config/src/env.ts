import { z } from "zod";

const baseEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
});

export type BaseEnv = z.infer<typeof baseEnvSchema>;

const apiEnvSchema = baseEnvSchema.extend({
  API_PORT: z.coerce.number().int().min(1).max(65535),
});
const workerEnvSchema = baseEnvSchema.extend({
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;
export type WorkerEnv = z.infer<typeof workerEnvSchema>;

type Source = Record<string, string | undefined>;

export class EnvError extends Error {
  override readonly name = "EnvError";
}

// Messages carry variable names and Zod's rule text only; Zod does not echo input values.
function parseWith<T>(schema: z.ZodType<T>, source: Source): T {
  const result = schema.safeParse(source);
  if (result.success) return result.data;
  const lines = result.error.issues.map((issue) => `- ${issue.path.join(".")}: ${issue.message}`);
  throw new EnvError(`Invalid environment variables:\n${lines.join("\n")}`);
}

export const parseEnv = (source: Source): BaseEnv => parseWith(baseEnvSchema, source);
export const parseApiEnv = (source: Source): ApiEnv => parseWith(apiEnvSchema, source);
export const parseWorkerEnv = (source: Source): WorkerEnv => parseWith(workerEnvSchema, source);

export const loadEnv = (): BaseEnv => parseEnv(process.env);
export const loadApiEnv = (): ApiEnv => parseApiEnv(process.env);
export const loadWorkerEnv = (): WorkerEnv => parseWorkerEnv(process.env);
