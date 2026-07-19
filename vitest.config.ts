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
      electron: fileURLToPath(new URL("./test/setup/electron-mock.ts", import.meta.url)),
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
    // file execution. Forks give each test file its own process. singleFork
    // stays at its default (false) — vitest 4 removed poolOptions, and the
    // fork-per-file behavior we need is now the default for pool:"forks".
    pool: "forks",
    isolate: true,
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "lcov"],
      include: ["src/**/*.ts", "packages/**/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/*.d.ts", "**/dist/**", "**/__tests__/**"],
      // Floors re-baselined for vitest 4: its v8 provider switched to
      // AST-aware branch/function counting, which enumerates far more
      // branch points (optional chains, nullish coalescing, default params)
      // than vitest 3 did — same tests, larger denominator. Branch coverage
      // reads 29.9% / functions 34.4% here where vitest 3 reported 74.6% /
      // 48.8% on the identical suite; the drop is the metric, not lost
      // coverage. Floors sit a few points under the vitest-4 actuals
      // (statements 33.6, branches 29.9, functions 34.4, lines 35.3) — a
      // regression ratchet, not a target. Raise as coverage grows; never
      // lower to make CI pass.
      thresholds: {
        statements: 32,
        branches: 27,
        functions: 32,
        lines: 33,
      },
    },
  },
});
