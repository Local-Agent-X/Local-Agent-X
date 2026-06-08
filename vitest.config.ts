import { fileURLToPath } from "node:url";
import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  // The @arikernel/* packages are consumed via their built dist/ in production,
  // but dist is gitignored and only rebuilt by `npm run build` — so tests would
  // otherwise run against a STALE dist. policy-engine owns the canonical
  // checkRegexSafety the app re-exports (src/safe-regex.ts); resolve it to
  // SOURCE here so tests exercise the live checker, not a stale build.
  resolve: {
    alias: {
      "@arikernel/policy-engine": fileURLToPath(
        new URL("./packages/arikernel/policy-engine/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: [
      "test/**/*.test.ts",
      "src/**/*.test.ts",
      "packages/**/__tests__/**/*.test.ts",
    ],
    exclude: [
      ...configDefaults.exclude,
      // Wall-clock perf budget (median < 500ms) — CPU-dependent, flaky on
      // slow CI runners. A benchmark, not a correctness check; run manually
      // or in a perf lane, not in the gate.
      "test/p4c5-voice-overhead-bench.test.ts",
    ],
    testTimeout: 15_000,
    setupFiles: ["test/setup/test-env.ts"],
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
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "lcov"],
      include: ["src/**/*.ts", "packages/**/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/*.d.ts", "**/dist/**", "**/__tests__/**"],
      // Floor set a few points below the current baseline (lines 37.5%,
      // functions 48.8%, branches 74.6%) — a regression ratchet, not a
      // target. Raise these as coverage grows; never lower to make CI pass.
      thresholds: {
        statements: 35,
        branches: 70,
        functions: 45,
        lines: 35,
      },
    },
  },
});
