import { afterEach, describe, expect, it, vi } from "vitest";
import { s3Settings } from "./test-support";

const S3 = {
  S3_ENDPOINT: "http://127.0.0.1:1",
  S3_BUCKET: "not-a-test-bucket",
  S3_ACCESS_KEY_ID: "id",
  S3_SECRET_ACCESS_KEY: "hunter2",
};

afterEach(() => vi.unstubAllEnvs());

describe("API harness S3 settings", () => {
  it("refuses an unverified run before returning any S3 configuration", () => {
    for (const [name, value] of Object.entries(S3)) vi.stubEnv(name, value);
    vi.stubEnv("CV_TEST_STACK_VERIFIED", "");
    vi.stubEnv("GITHUB_ACTIONS", "");
    vi.stubEnv("CI", "");
    expect(() => s3Settings()).toThrow(/^(?!.*hunter2).*refused/s);
  });

  it("returns the settings on the verified stack", () => {
    for (const [name, value] of Object.entries(S3)) vi.stubEnv(name, value);
    vi.stubEnv("CV_TEST_STACK_VERIFIED", "1");
    expect(s3Settings()["S3_BUCKET"]).toBe("not-a-test-bucket");
  });
});
