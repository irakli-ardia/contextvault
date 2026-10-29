import { defineConfig, devices } from "@playwright/test";

// Dedicated web port so a running dev server (3000) can never be mistaken for the tested build.
// The API uses its default port because the web build bakes in the rewrite destination
// (`API_INTERNAL_URL`, default http://127.0.0.1:3001); a running dev API makes this run fail loudly.
const port = 3100;
const baseURL = `http://127.0.0.1:${port}`;

// Servers inherit the runner's environment and the API loads .env; blank every credential above the
// application role (test tooling, the schema owner, the bootstrap superuser and the Compose-only
// passwords) so none reaches a server. An empty process value beats --env-file.
const noPrivilegedCredentials = {
  DATABASE_FIXTURE_URL: "",
  DATABASE_BOOTSTRAP_URL: "",
  DATABASE_MIGRATION_URL: "",
  POSTGRES_PASSWORD: "",
  POSTGRES_APP_PASSWORD: "",
  POSTGRES_OWNER_PASSWORD: "",
  POSTGRES_FIXTURE_PASSWORD: "",
};

export default defineConfig({
  testDir: "apps/web/e2e",
  fullyParallel: true,
  // One worker: every login costs a 64 MiB Argon2id hash behind a two-slot queue.
  workers: 1,
  forbidOnly: true,
  retries: 0,
  reporter: [["list"]],
  outputDir: "test-results",
  use: { baseURL, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      // Built API against the real Postgres from .env; the process environment (below) wins over
      // .env. The log file lets the tests prove no secret reaches it.
      command:
        "mkdir -p playwright-report && node --env-file-if-exists=.env apps/api/dist/main.mjs > playwright-report/api.log 2>&1",
      cwd: ".",
      env: {
        ...noPrivilegedCredentials,
        NODE_ENV: "development",
        API_PORT: "3001",
        API_HOST: "127.0.0.1",
        WEB_ORIGIN: baseURL,
        // Reached only through the Next server, never directly by a client: no appended address.
        TRUSTED_PROXY_HOPS: "0",
      },
      url: "http://127.0.0.1:3001/health",
      reuseExistingServer: false,
      timeout: 60_000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    },
    {
      // The binary, not `pnpm exec`: a wrapper reports its own SIGTERM as a failure and can outlive the run.
      command: `./node_modules/.bin/next start --hostname 127.0.0.1 --port ${port} > ../../playwright-report/web.log 2>&1`,
      cwd: "apps/web",
      env: noPrivilegedCredentials,
      url: baseURL,
      reuseExistingServer: false,
      timeout: 60_000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    },
    {
      // Same build, pointed at a test-only upstream (apps/web/e2e/upload-stub.ts) so the upload
      // transport can be exercised before the API endpoint exists. The upload route reads
      // API_INTERNAL_URL at runtime; the baked rewrite destination is irrelevant to it.
      command:
        "./node_modules/.bin/next start --hostname 127.0.0.1 --port 3101 > ../../playwright-report/web-upload.log 2>&1",
      cwd: "apps/web",
      env: { ...noPrivilegedCredentials, API_INTERNAL_URL: "http://127.0.0.1:3199" },
      url: "http://127.0.0.1:3101",
      reuseExistingServer: false,
      timeout: 60_000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    },
  ],
});
