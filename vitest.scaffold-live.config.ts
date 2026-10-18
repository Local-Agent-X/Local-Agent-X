// `npm run test:scaffold-live`: the one test that runs every framework's
// official creator for real (network, minutes), skipped by the default suite.
// The env var is the gate the test reads; this config is how a cross-platform
// npm script sets it.
import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.js";

export default mergeConfig(base, defineConfig({
  test: {
    include: ["test/scaffold-live.test.ts"],
    env: { LAX_SCAFFOLD_LIVE: "1" },
    testTimeout: 15 * 60_000,
    hookTimeout: 15 * 60_000,
  },
}));
