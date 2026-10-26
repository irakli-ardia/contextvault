import { z } from "zod";

const baseEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
});

export type BaseEnv = z.infer<typeof baseEnvSchema>;

// Reusable fragments for the apps that first read them (M1 adapters). Neither api nor worker
// requires these yet, so neither depends on Postgres or S3 settings it does not use.
const databaseEnvSchema = baseEnvSchema.extend({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
});
// Owner-role connection, read only by the explicit migration command, never by an app.
const migrationEnvSchema = baseEnvSchema.extend({
  DATABASE_MIGRATION_URL: z.url({ protocol: /^postgres(ql)?$/ }),
});
const s3EnvSchema = baseEnvSchema.extend({
  S3_ENDPOINT: z.url({ protocol: /^https?$/ }),
  S3_REGION: z.string().min(1).default("us-east-1"),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
});

const apiEnvSchema = baseEnvSchema.extend({
  API_PORT: z.coerce.number().int().min(1).max(65535),
});
const workerEnvSchema = baseEnvSchema.extend({
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;
export type WorkerEnv = z.infer<typeof workerEnvSchema>;
export type DatabaseEnv = z.infer<typeof databaseEnvSchema>;
export type MigrationEnv = z.infer<typeof migrationEnvSchema>;
export type S3Env = z.infer<typeof s3EnvSchema>;

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

export const parseDatabaseEnv = (source: Source): DatabaseEnv =>
  parseWith(databaseEnvSchema, source);
export const parseMigrationEnv = (source: Source): MigrationEnv =>
  parseWith(migrationEnvSchema, source);
export const parseS3Env = (source: Source): S3Env => parseWith(s3EnvSchema, source);

export const loadEnv = (): BaseEnv => parseEnv(process.env);
export const loadApiEnv = (): ApiEnv => parseApiEnv(process.env);
export const loadWorkerEnv = (): WorkerEnv => parseWorkerEnv(process.env);
export const loadDatabaseEnv = (): DatabaseEnv => parseDatabaseEnv(process.env);
export const loadMigrationEnv = (): MigrationEnv => parseMigrationEnv(process.env);
export const loadS3Env = (): S3Env => parseS3Env(process.env);
