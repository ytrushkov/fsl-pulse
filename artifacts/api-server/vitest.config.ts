import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests live in two places: `src/**/*.test.ts` (co-located with the
    // code under test) and `test/**/*.test.ts` (route-level integration
    // suites that mock @workspace/db wholesale).
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    environment: "node",
    testTimeout: 20000,
    hookTimeout: 20000,
    pool: "forks",
    forks: { singleFork: true },
  },
});
