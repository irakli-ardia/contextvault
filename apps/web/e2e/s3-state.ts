import { execFileSync } from "node:child_process";
import { curlQuote, verifiedValue as need } from "./stack-env";

// Looks at the private bucket the way an operator would: signed `curl`, credentials on stdin (never
// in the process list). Test code only; the API's own adapter is covered by its integration tests.
// The values are the verified stack's, injected by scripts/checks/with-test-stack.mjs, which also
// sets CV_TEST_STACK_VERIFIED. Without it nothing here runs: `.env` is never read, so cleanup
// cannot reach the development bucket.
const S3_ENDPOINT = need("S3_ENDPOINT");
const S3_BUCKET = need("S3_BUCKET");
const S3_REGION = need("S3_REGION");
const S3_ACCESS_KEY_ID = need("S3_ACCESS_KEY_ID");
export const S3_SECRET_ACCESS_KEY = need("S3_SECRET_ACCESS_KEY");

function curl(args: string[], signed: boolean, body = false): string {
  const url = (key: string) => `${S3_ENDPOINT}/${S3_BUCKET}/${key}`;
  const [method = "GET", key = ""] = args;
  const flags = signed ? ["--aws-sigv4", `aws:amz:${S3_REGION}:s3`, "--config", "-"] : [];
  return execFileSync(
    "curl",
    [
      "-q", // first: no ~/.curlrc
      "-s",
      "--noproxy",
      "*",
      ...(body ? [] : ["-o", "/dev/null", "-D", "-"]),
      "--max-time",
      "10",
      ...flags,
      ...(method === "HEAD" ? ["-I"] : ["-X", method]),
      url(key),
    ],
    {
      input: signed ? `user = "${curlQuote(`${S3_ACCESS_KEY_ID}:${S3_SECRET_ACCESS_KEY}`)}"\n` : "",
      encoding: "utf8",
    },
  );
}

const statusOf = (headers: string) => Number(/^HTTP\/\S+ (\d{3})/.exec(headers)?.[1] ?? 0);

/** What the bucket holds under `key`: status and stored length (HEAD, signed). */
export function objectState(key: string): { status: number; length: number | null } {
  const headers = curl(["HEAD", key], true);
  const length = /^content-length: (\d+)/im.exec(headers)?.[1];
  return { status: statusOf(headers), length: length === undefined ? null : Number(length) };
}

/** A GET without credentials: a private bucket answers 403. */
export const anonymousStatus = (key: string): number => statusOf(curl(["GET", key], false));

export function deleteObject(key: string): void {
  curl(["DELETE", key], true);
}

/** Every object key under `prefix` (signed ListObjectsV2; a workspace holds far fewer than 1000). */
export function listKeys(prefix: string): string[] {
  const xml = curl(["GET", `?list-type=2&prefix=${encodeURIComponent(prefix)}`], true, true);
  return [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((match) => match[1] ?? "");
}
