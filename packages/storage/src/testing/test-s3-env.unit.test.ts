import { describe, expect, it } from "vitest";
import { testS3Env } from "./test-s3-env";

const at = (S3_ENDPOINT: string) => ({ S3_ENDPOINT, S3_BUCKET: "b" });
const ci = { GITHUB_ACTIONS: "true", CI: "true" };

describe("testS3Env", () => {
  it("accepts the verified local stack, whatever the endpoint", () => {
    const s3 = at("http://127.0.0.1:58333");
    expect(testS3Env(s3, { CV_TEST_STACK_VERIFIED: "1" })).toBe(s3);
  });

  it("accepts a loopback SeaweedFS on GitHub Actions", () => {
    const s3 = at("http://127.0.0.1:8333");
    expect(testS3Env(s3, ci)).toBe(s3);
  });

  it("refuses an unverified local run", () => {
    expect(() => testS3Env(at("http://127.0.0.1:8333"), {})).toThrow("refused");
  });

  it("does not trust CI=true, GITHUB_ACTIONS=true or a wrong marker alone", () => {
    const s3 = at("http://127.0.0.1:8333");
    expect(() => testS3Env(s3, { CI: "true" })).toThrow("refused");
    expect(() => testS3Env(s3, { GITHUB_ACTIONS: "true" })).toThrow("refused");
    expect(() => testS3Env(s3, { CV_TEST_STACK_VERIFIED: "true" })).toThrow("refused");
  });

  it("refuses a non-loopback endpoint on GitHub Actions", () => {
    expect(() => testS3Env(at("https://s3.amazonaws.com"), ci)).toThrow("refused");
    expect(() => testS3Env(at("http://127.0.0.1.evil.example:8333"), ci)).toThrow("refused");
  });

  it("does not echo the endpoint or credentials in the refusal", () => {
    const s3 = { S3_ENDPOINT: "https://secret-host.example", S3_SECRET_ACCESS_KEY: "hunter2" };
    expect(() => testS3Env(s3, {})).toThrow(/^(?!.*(secret-host|hunter2))/s);
  });
});
