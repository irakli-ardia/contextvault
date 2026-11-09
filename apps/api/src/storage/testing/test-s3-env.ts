const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

type LaunchFlags = {
  CV_TEST_STACK_VERIFIED?: string | undefined;
  GITHUB_ACTIONS?: string | undefined;
  CI?: string | undefined;
};

/**
 * The S3 settings an integration test may touch. Verified runs (with-test-stack.mjs sets
 * CV_TEST_STACK_VERIFIED after its endpoint and identity checks) use the injected env.
 * GitHub Actions has no wrapper: its runner-owned SeaweedFS is accepted only on loopback.
 * CI=true alone is not enough, and a bare local run is refused.
 */
export function testS3Env<T extends { S3_ENDPOINT: string }>(s3: T, flags: LaunchFlags): T {
  if (flags.CV_TEST_STACK_VERIFIED === "1") return s3;
  if (
    flags.GITHUB_ACTIONS === "true" &&
    flags.CI === "true" &&
    LOOPBACK.has(new URL(s3.S3_ENDPOINT).hostname)
  ) {
    return s3;
  }
  throw new Error(
    "S3 integration test refused: run through scripts/checks/with-test-stack.mjs (or GitHub Actions with a loopback SeaweedFS)",
  );
}
