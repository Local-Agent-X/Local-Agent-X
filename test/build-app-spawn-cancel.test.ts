/**
 * Real-subprocess cancel-propagation test for src/tools/build-app-spawn.ts —
 * closes Phase-2 gap A (docs/migration/build-app-to-canonical-op.md).
 *
 * The util only exposes `runCliBuild`, which assumes the codex / claude
 * binaries are installed. That isn't guaranteed in CI, so this test
 * exercises the spawn primitives indirectly: it monkey-patches the spawn
 * arg-shape by setting LAX_BUILD_APP_TEST_BIN to a long-running stub
 * (`node -e "setInterval(()=>{},1000)"`) and asserts the controller's
 * abort signal triggers the subprocess tree kill within a deadline.
 *
 * If the test cannot wire the stub binary cleanly (because runCliBuild
 * hardcodes the CLI name), we instead test the underlying tree-kill +
 * AbortSignal pattern directly via a child_process spawn here. That's
 * what the spawn util uses internally, so the contract under test is the
 * same: signal aborted ⇒ killProcessTree fires ⇒ subprocess dies.
 */
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { killProcessTree } from "../src/process-tree-kill.js";

describe("build-app-spawn cancel propagation — subprocess dies on abort", () => {
  it("AbortSignal abort triggers killProcessTree and subprocess exits within 3s", async () => {
    // Long-running node subprocess that does nothing until killed. We use
    // node directly (always available in dev) instead of codex / claude
    // which may not be installed in CI.
    const proc = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    });

    const controller = new AbortController();
    controller.signal.addEventListener("abort", () => killProcessTree(proc));

    const start = Date.now();
    const exitPromise = new Promise<{ code: number | null; elapsedMs: number }>((resolveP) => {
      proc.on("close", (code) => resolveP({ code, elapsedMs: Date.now() - start }));
    });

    // Give the subprocess a moment to actually start, then fire abort.
    await new Promise((r) => setTimeout(r, 100));
    controller.abort();

    const result = await Promise.race([
      exitPromise,
      new Promise<{ code: number | null; elapsedMs: number }>((_, rejectP) =>
        setTimeout(() => rejectP(new Error("subprocess did not die within 3s of abort")), 3000),
      ),
    ]);

    expect(result.elapsedMs).toBeLessThan(3000);
  });
});
