import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "test/**/*.test.ts",
      "src/**/*.test.ts",
      "packages/**/__tests__/**/*.test.ts",
    ],
    testTimeout: 15_000,
    // Force the deterministic file-fallback master key. The OS keychain path
    // (DPAPI on Windows) shells out to PowerShell per SecretsStore boot, which
    // races and intermittently mismatches the encrypt/decrypt key when many
    // forks run concurrently. No test asserts the OS-keychain provider.
    env: {
      LAX_DISABLE_OS_KEYCHAIN: "1",
    },
    // Native addons (better-sqlite3, sqlite-vec, sherpa-onnx) are not safe to
    // share across worker threads — a "threads" pool segfaults under concurrent
    // file execution. Forks give each test file its own process.
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: false,
      },
    },
    isolate: true,
  },
});
