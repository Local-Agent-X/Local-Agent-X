import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 15_000,
    pool: "threads",
    poolOptions: {
      threads: {
        singleThread: false,
      },
    },
    isolate: true,
  },
});
