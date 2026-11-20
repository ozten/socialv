import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Each test file starts its own board on a free port, so files can run in parallel.
    pool: "forks",
  },
});
