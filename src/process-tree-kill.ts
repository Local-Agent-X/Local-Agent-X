/**
 * Cross-platform tree-kill for child_process.spawn'd subprocesses.
 *
 * On Windows we typically spawn with `shell: true` so a cmd.exe wrapper
 * relays argv to the real binary. `proc.kill()` only signals the wrapper —
 * the descendant binary (claude.exe, codex.exe, etc.) is left orphaned
 * as a detached child. `taskkill /F /T` walks the process tree and
 * terminates the whole subtree.
 *
 * Use this anywhere a spawned subprocess might be aborted before
 * natural completion (user Stop, timeout, lease loss, abort signal).
 */
import type { ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

export function killProcessTree(
  proc: ChildProcess | null | undefined,
  signal: NodeJS.Signals = "SIGTERM",
): void {
  if (!proc) return;
  try { proc.kill(signal); } catch { /* ignore */ }
  if (process.platform === "win32" && proc.pid) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("node:child_process").execSync(
        `taskkill /PID ${proc.pid} /F /T`,
        { stdio: "ignore", windowsHide: true },
      );
    } catch { /* ignore */ }
  }
}
