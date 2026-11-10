import { join } from "node:path";
import { expect, it } from "vitest";
import { ENV_FILE } from "./run-with-env.mjs";

// A missed `../` reads no file and silently yields {}, and the temp-tree tests copy the launcher to
// a fixed depth of their own, so the real file's depth is pinned here: the repository-root `.env`.
it("ENV_FILE is the repository-root .env", () => {
  expect(ENV_FILE).toBe(join(import.meta.dirname, "../../.env"));
  expect(ENV_FILE).not.toBe(join(import.meta.dirname, "../.env"));
});
