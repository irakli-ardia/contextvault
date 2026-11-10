import { describe, expect, it, vi } from "vitest";

const execFileSync = vi.hoisted(() => vi.fn(() => "HTTP/1.1 200 OK\r\n"));
vi.mock("node:child_process", () => ({ execFileSync }));

const STACK = {
  S3_ENDPOINT: "http://127.0.0.1:58333",
  S3_REGION: "us-east-1",
  S3_BUCKET: "contextvault-test",
  S3_ACCESS_KEY_ID: "test-key-id",
  S3_SECRET_ACCESS_KEY: "test-secret-value",
};
const load = async (env) => {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  return import("../../apps/web/e2e/s3-state.ts");
};

// The E2E S3 helper deletes objects, so it runs only for a stack that with-test-stack.mjs verified.
describe("E2E S3 helper guard", () => {
  it("refuses a complete S3 configuration that was not verified", async () => {
    await expect(load({ ...STACK, CV_TEST_STACK_VERIFIED: "" })).rejects.toThrow(
      "not set by a verified stack",
    );
  });

  it("refuses a verified flag without the values, never reading .env", async () => {
    await expect(
      load({ CV_TEST_STACK_VERIFIED: "1", S3_ENDPOINT: STACK.S3_ENDPOINT }),
    ).rejects.toThrow("S3_");
  });

  it("loads for a verified stack and exposes the injected secret", async () => {
    const helper = await load({ ...STACK, CV_TEST_STACK_VERIFIED: "1" });
    expect(helper.S3_SECRET_ACCESS_KEY).toBe(STACK.S3_SECRET_ACCESS_KEY);
  });

  it("runs curl without ~/.curlrc or proxies and escapes the credentials", async () => {
    const helper = await load({
      ...STACK,
      S3_SECRET_ACCESS_KEY: 'se"cr\\et',
      CV_TEST_STACK_VERIFIED: "1",
    });
    helper.objectState("k");
    const [file, args, options] = execFileSync.mock.calls[0];
    expect(file).toBe("curl");
    expect(args[0]).toBe("-q");
    expect(args.join(" ")).toContain("--noproxy *");
    expect(options.input).toBe('user = "test-key-id:se\\"cr\\\\et"\n');
  });
});
