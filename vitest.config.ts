import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["{apps,packages}/*/src/**/*.unit.test.ts"],
          environment: "node",
          globals: false,
          restoreMocks: true,
          unstubEnvs: true,
        },
      },
    ],
  },
});
