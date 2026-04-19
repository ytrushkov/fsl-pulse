import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 20000,
    hookTimeout: 20000,
    pool: "forks",
    forks: { singleFork: true },
  },
});
