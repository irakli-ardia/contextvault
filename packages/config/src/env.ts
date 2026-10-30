import { z } from "zod";

const baseEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
});

export type BaseEnv = z.infer<typeof baseEnvSchema>;

// Reusable fragments for the apps that read them. The worker needs neither Postgres nor S3 yet,
// so it depends on no setting it does not use.
const databaseEnvSchema = baseEnvSchema.extend({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
});
// Ingestion-worker role (NOBYPASSRLS, DML only through reviewed grants): its own URL, never
// DATABASE_URL, so a worker cannot run with the application role's reach or the reverse.
const workerDatabaseEnvSchema = baseEnvSchema.extend({
  DATABASE_WORKER_URL: z.url({ protocol: /^postgres(ql)?$/ }),
});
// Owner-role connection, read only by the explicit migration command, never by an app.
// Pure-annotated so an app bundle that never calls the migration loaders drops it.
const migrationEnvSchema = /* @__PURE__ */ baseEnvSchema.extend({
  DATABASE_MIGRATION_URL: z.url({ protocol: /^postgres(ql)?$/ }),
});
// Test-tooling connections (.env.test, never .env): a fixture role for seeds and cleanup, and a
// bootstrap superuser for catalog probes. Each loader returns only its URL, never falls back to
// DATABASE_URL, and refuses production, so a stray copy of these credentials cannot run an app.
const refuseProduction = (env: { NODE_ENV: string }, ctx: z.RefinementCtx<unknown>): void => {
  if (env.NODE_ENV === "production") {
    ctx.addIssue({ code: "custom", path: ["NODE_ENV"], message: "Refused in production" });
  }
};
const postgresUrl = z.url({ protocol: /^postgres(ql)?$/ });
const fixtureEnvSchema = /* @__PURE__ */ baseEnvSchema
  .extend({ DATABASE_FIXTURE_URL: postgresUrl })
  .superRefine(refuseProduction)
  .transform((env) => ({ DATABASE_FIXTURE_URL: env.DATABASE_FIXTURE_URL }));
const bootstrapEnvSchema = /* @__PURE__ */ baseEnvSchema
  .extend({ DATABASE_BOOTSTRAP_URL: postgresUrl })
  .superRefine(refuseProduction)
  .transform((env) => ({ DATABASE_BOOTSTRAP_URL: env.DATABASE_BOOTSTRAP_URL }));
const s3Fields = {
  S3_ENDPOINT: z.url({ protocol: /^https?$/ }),
  S3_REGION: z.string().min(1).default("us-east-1"),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
};
// The endpoint is a bare origin (no credentials, path, or query) so object keys are the only thing
// that varies per request, and it is https in production. The adapter never creates the bucket.
const refineS3 = (
  env: { NODE_ENV: string; S3_ENDPOINT: string },
  ctx: z.RefinementCtx<unknown>,
): void => {
  // Refinements also run when a field failed its own check, hence canParse.
  if (!URL.canParse(env.S3_ENDPOINT) || env.S3_ENDPOINT !== new URL(env.S3_ENDPOINT).origin) {
    ctx.addIssue({ code: "custom", path: ["S3_ENDPOINT"], message: "Must be a bare origin" });
  }
  if (env.NODE_ENV === "production" && !env.S3_ENDPOINT.startsWith("https://")) {
    ctx.addIssue({ code: "custom", path: ["S3_ENDPOINT"], message: "Must be https in production" });
  }
};
const s3EnvSchema = baseEnvSchema.extend(s3Fields).superRefine(refineS3);

// API_HOST is an explicit bind address (no all-interfaces default). WEB_ORIGIN is the one origin
// allowed to make unsafe requests: a bare origin, https in production. TRUSTED_PROXY_HOPS feeds
// Express `trust proxy`; it has no production default because a wrong count makes the client
// address spoofable.
const apiEnvSchema = databaseEnvSchema
  .extend(s3Fields)
  .extend({
    API_PORT: z.coerce.number().int().min(1).max(65535),
    API_HOST: z.string().min(1),
    WEB_ORIGIN: z.url({ protocol: /^https?$/ }),
    TRUSTED_PROXY_HOPS: z
      .string()
      .regex(/^[0-3]$/)
      .transform(Number)
      .optional(),
  })
  .superRefine((env, ctx) => {
    refineS3(env, ctx);
    // Refinements also run when a field failed its own check, hence canParse.
    if (!URL.canParse(env.WEB_ORIGIN) || env.WEB_ORIGIN !== new URL(env.WEB_ORIGIN).origin) {
      ctx.addIssue({ code: "custom", path: ["WEB_ORIGIN"], message: "Must be a bare origin" });
    }
    if (env.NODE_ENV !== "production") return;
    if (!env.WEB_ORIGIN.startsWith("https://")) {
      ctx.addIssue({
        code: "custom",
        path: ["WEB_ORIGIN"],
        message: "Must be https in production",
      });
    }
    if (env.TRUSTED_PROXY_HOPS === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["TRUSTED_PROXY_HOPS"],
        message: "Required in production",
      });
    }
  })
  .transform((env) => ({ ...env, TRUSTED_PROXY_HOPS: env.TRUSTED_PROXY_HOPS ?? 0 }));
// The one API origin the web app may reach. It must be a bare origin (no path or credentials) so
// the proxy can only ever reach that one backend. The default is the loopback development API; a
// deployment that forgets it fails closed (connection refused).
// Read twice, at different times (ADR 0009): `next build` bakes it into the `/api/*` rewrite, and
// the upload Route Handler reads it again from the process environment at runtime. Set the same
// value for the build and for the running server, or the two paths target different origins.
const webEnvSchema = z.object({
  API_INTERNAL_URL: z
    .url({ protocol: /^https?$/ })
    // Refinements also run when the URL check failed, hence canParse.
    .refine((url) => URL.canParse(url) && new URL(url).origin === url, "Must be a bare origin")
    .default("http://127.0.0.1:3001"),
});
const workerEnvSchema = baseEnvSchema.extend({
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;
export type WebEnv = z.infer<typeof webEnvSchema>;
export type WorkerEnv = z.infer<typeof workerEnvSchema>;
export type DatabaseEnv = z.infer<typeof databaseEnvSchema>;
export type WorkerDatabaseEnv = z.infer<typeof workerDatabaseEnvSchema>;
export type MigrationEnv = z.infer<typeof migrationEnvSchema>;
export type FixtureEnv = z.infer<typeof fixtureEnvSchema>;
export type BootstrapEnv = z.infer<typeof bootstrapEnvSchema>;
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
export const parseWebEnv = (source: Source): WebEnv => parseWith(webEnvSchema, source);
export const parseWorkerEnv = (source: Source): WorkerEnv => parseWith(workerEnvSchema, source);

export const parseDatabaseEnv = (source: Source): DatabaseEnv =>
  parseWith(databaseEnvSchema, source);
export const parseWorkerDatabaseEnv = (source: Source): WorkerDatabaseEnv =>
  parseWith(workerDatabaseEnvSchema, source);
export const parseMigrationEnv = (source: Source): MigrationEnv =>
  parseWith(migrationEnvSchema, source);
export const parseFixtureEnv = (source: Source): FixtureEnv => parseWith(fixtureEnvSchema, source);
export const parseBootstrapEnv = (source: Source): BootstrapEnv =>
  parseWith(bootstrapEnvSchema, source);
export const parseS3Env = (source: Source): S3Env => parseWith(s3EnvSchema, source);

export const loadEnv = (): BaseEnv => parseEnv(process.env);
export const loadApiEnv = (): ApiEnv => parseApiEnv(process.env);
export const loadWebEnv = (): WebEnv => parseWebEnv(process.env);
export const loadWorkerEnv = (): WorkerEnv => parseWorkerEnv(process.env);
export const loadDatabaseEnv = (): DatabaseEnv => parseDatabaseEnv(process.env);
export const loadWorkerDatabaseEnv = (): WorkerDatabaseEnv => parseWorkerDatabaseEnv(process.env);
export const loadMigrationEnv = (): MigrationEnv => parseMigrationEnv(process.env);
export const loadS3Env = (): S3Env => parseS3Env(process.env);
export const loadFixtureEnv = (): FixtureEnv => parseFixtureEnv(process.env);
export const loadBootstrapEnv = (): BootstrapEnv => parseBootstrapEnv(process.env);
