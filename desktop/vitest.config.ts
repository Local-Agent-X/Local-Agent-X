import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Desktop's OWN vitest config — deliberately standalone.
 *
 * WHY a separate config (not the root one):
 *  - The repo root vitest config sets `setupFiles: ["test/setup/test-env.ts"]`.
 *    That path is resolved relative to the RUNNING project root; when the
 *    desktop project runs, `test/setup/test-env.ts` does not exist under
 *    desktop/ and the run dies at collection. The C3 skeptic hit exactly this.
 *    The desktop CSP builder is a pure function (no HOME / keychain / secrets
 *    deps), so it needs NO setup fixture — we inherit nothing and set none.
 *  - `root` is pinned to desktop/ so `include` resolves to desktop/src and the
 *    desktop-local node_modules (tldts) are used, matching how the app builds.
 *
 * Runnable two ways, both green:
 *   - from desktop/:  vitest run                 (desktop package "test" script)
 *   - from repo root: vitest run --config desktop/vitest.config.ts  (test:desktop)
 */
export default defineConfig({
	root: fileURLToPath(new URL(".", import.meta.url)),
	test: {
		include: ["src/**/*.test.ts"],
		// Intentionally empty: do NOT inherit the root setupFiles — see header.
		setupFiles: [],
		pool: "forks",
		isolate: true,
	},
});
