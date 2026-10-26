import { defineConfig, devices } from "@playwright/test";

// Dedicated port so a running dev server (3000) can never be mistaken for the tested build.
const port = 3100;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "apps/web/e2e",
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  reporter: [["list"]],
  outputDir: "test-results",
  use: { baseURL, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // The binary, not `pnpm exec`: a wrapper reports its own SIGTERM as a failure and can outlive the run.
    command: `./node_modules/.bin/next start --hostname 127.0.0.1 --port ${port}`,
    cwd: "apps/web",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 60_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
  },
});
