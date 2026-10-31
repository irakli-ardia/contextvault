const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

type LaunchFlags = {
  CV_TEST_STACK_VERIFIED?: string | undefined;
  GITHUB_ACTIONS?: string | undefined;
  CI?: string | undefined;
};

/**
 * The Redis URL an integration test may touch. Verified runs (with-test-stack.mjs sets
 * CV_TEST_STACK_VERIFIED after its endpoint and identity checks) use the injected REDIS_URL.
 * GitHub Actions has no wrapper: its runner-owned Redis service is accepted only on loopback.
 * CI=true alone is not enough, and a bare local run is refused.
 */
export function testRedisUrl(redisUrl: string, flags: LaunchFlags): URL {
  const url = new URL(redisUrl);
  if (flags.CV_TEST_STACK_VERIFIED === "1") return url;
  if (flags.GITHUB_ACTIONS === "true" && flags.CI === "true" && LOOPBACK.has(url.hostname)) {
    return url;
  }
  throw new Error(
    "Redis integration test refused: run through scripts/checks/with-test-stack.mjs (or GitHub Actions with a loopback Redis)",
  );
}
