import { describe, expect, it } from "vitest";
import config from "../playwright.config.ts";

const [api, web, upload] = config.webServer;
const PRIVILEGED = /DATABASE_(FIXTURE|BOOTSTRAP|MIGRATION)_URL|POSTGRES_|REDIS_PASSWORD/;

// Playwright merges each `env` over the runner's environment, so isolation lives in the launcher's
// allowlist; the config must only route every server through it and forward nothing privileged.
describe("playwright webServer", () => {
  it("has the api and two web servers", () => {
    expect(config.webServer).toHaveLength(3);
  });

  it("starts every server through the launcher with the matching mode", () => {
    expect(api.command).toContain("node scripts/run-with-env.mjs api apps/api/dist/main.mjs");
    for (const server of [web, upload]) {
      expect(server.command).toContain(
        "node ../../scripts/run-with-env.mjs web node_modules/next/dist/bin/next start",
      );
    }
    expect([api.cwd, web.cwd, upload.cwd]).toEqual([".", "apps/web", "apps/web"]);
  });

  it("loads no env file and forwards no privileged variable", () => {
    for (const server of config.webServer) {
      expect(server.command).not.toContain("--env-file");
      expect(Object.keys(server.env ?? {}).filter((name) => PRIVILEGED.test(name))).toEqual([]);
    }
    expect(Object.keys(api.env).sort()).toEqual([
      "API_HOST",
      "API_PORT",
      "NODE_ENV",
      "TRUSTED_PROXY_HOPS",
      "WEB_ORIGIN",
    ]);
    expect(web.env).toBeUndefined();
  });

  it("keeps the ports, readiness and shutdown settings", () => {
    expect(api.url).toBe("http://127.0.0.1:3001/health");
    expect([web.url, upload.url]).toEqual(["http://127.0.0.1:3100", "http://127.0.0.1:3101"]);
    expect(web.command).toContain("--hostname 127.0.0.1 --port 3100 >");
    expect(upload.command).toContain("--hostname 127.0.0.1 --port 3101 >");
    expect(api.env.API_PORT).toBe("3001");
    for (const server of config.webServer) {
      expect(server.reuseExistingServer).toBe(false);
      expect(server.timeout).toBe(60_000);
      expect(server.gracefulShutdown).toEqual({ signal: "SIGTERM", timeout: 5_000 });
    }
  });

  it("keeps log redirection and the upload stub upstream", () => {
    expect(api.command).toContain("> playwright-report/api.log 2>&1");
    expect(web.command).toContain("> ../../playwright-report/web.log 2>&1");
    expect(upload.command).toContain("> ../../playwright-report/web-upload.log 2>&1");
    expect(upload.env).toEqual({ API_INTERNAL_URL: "http://127.0.0.1:3199" });
  });
});
