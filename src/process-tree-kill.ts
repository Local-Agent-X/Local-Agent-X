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
import { spawn, type ChildProcess } from "node:child_process";
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

/**
 * Best-effort kill of a DETACHED process and its whole group, by pid.
 *
 * Unlike {@link killProcessTree} (which signals a known ChildProcess and, on
 * Windows, taskkills its tree), this targets a process spawned DETACHED so it
 * leads its own process group: on POSIX a negative-pid SIGKILL takes down the
 * entire group — the children the agent cares about (shells, dev servers) that
 * a plain proc.kill would orphan — falling back to killing just `fallbackChild`
 * if the group kill throws (the pid wasn't a group leader). On Windows
 * `taskkill /F /T` walks the tree the same way. Never throws.
 *
 * The ONE home for detached-spawn tree-killing: process-session
 * (killSession/killWinPid) and the shell tool's abort handler all route here so
 * the platform logic can't drift between them.
 */
export function killProcessGroup(pid: number, fallbackChild?: ChildProcess): void {
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { windowsHide: true, stdio: "ignore" });
    } else {
      try { process.kill(-pid, "SIGKILL"); } catch { fallbackChild?.kill("SIGKILL"); }
    }
  } catch { /* best-effort */ }
}

/**
 * Synchronous {@link killProcessGroup}. Required in two places the async spawn
 * can't serve: `process.on("exit")` handlers (the event loop is already drained,
 * so a spawned taskkill never runs — on Windows that silently orphaned every
 * dev-server child past a graceful LAX quit, leaving them holding their ports)
 * and callers that must observe the port free before spawning a replacement.
 * POSIX group-kill is synchronous either way. Never throws.
 */
export function killProcessGroupSync(pid: number, fallbackChild?: ChildProcess): void {
  try {
    if (process.platform === "win32") {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("node:child_process").execSync(
        `taskkill /PID ${pid} /F /T`,
        { stdio: "ignore", windowsHide: true, timeout: 5000 },
      );
    } else {
      try { process.kill(-pid, "SIGKILL"); } catch { fallbackChild?.kill("SIGKILL"); }
    }
  } catch { /* best-effort */ }
}
