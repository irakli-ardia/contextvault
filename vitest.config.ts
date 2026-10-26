import { defineConfig } from "vitest/config";

const shared = {
  environment: "node",
  globals: false,
  restoreMocks: true,
  unstubEnvs: true,
} as const;

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          ...shared,
          name: "unit",
          include: ["{apps,packages}/*/src/**/*.unit.test.ts"],
        },
      },
      {
        test: {
          ...shared,
          name: "integration",
          include: ["{apps,packages}/*/src/**/*.integration.test.ts"],
          testTimeout: 15_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
