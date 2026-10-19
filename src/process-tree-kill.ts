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
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

export function killProcessTree(
  proc: ChildProcess | null | undefined,
  signal: NodeJS.Signals = "SIGTERM",
): void {
  if (!proc) return;
  if (process.platform === "win32" && proc.pid) {
    // TREE FIRST, wrapper second. `taskkill /T` walks the LIVE parent→child
    // links; killing the cmd.exe wrapper before running it left taskkill
    // resolving a dead pid, finding nothing, and orphaning every grandchild —
    // npm → tsc / vite / a dev server surviving the "kill" and holding cores
    // and file handles for its full natural lifetime. Ordering is the fix.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("node:child_process").execSync(
        `taskkill /PID ${proc.pid} /F /T`,
        { stdio: "ignore", windowsHide: true, timeout: 5000 },
      );
    } catch { /* ignore */ }
  }
  // Still signal the wrapper: on POSIX this IS the kill, and on Windows it
  // covers a taskkill that couldn't run. Throws ESRCH once the tree kill
  // already reaped it — expected, and swallowed.
  try { proc.kill(signal); } catch { /* ignore */ }
}

/**
 * Synchronous kill of what a process that is already dead left running, for a
 * runner that could not tree-kill it while it was alive: execFileSync and
 * spawnSync end a timed-out or over-limit call by killing their own child only.
 * On Windows that child's children live on (a hook git was waiting on, and the
 * native program it runs in the repo) and keep the dead pid as their parent,
 * so they are found by it and killed with their own children, and this returns
 * once they are gone. Only processes created inside the call
 * (`startedAtMs`..`endedAtMs`, Date.now() values) count: a pid reused after
 * the child died cannot have fathered them. No-op elsewhere. Never throws.
 */
export function killOrphansOfSync(deadPid: number, startedAtMs: number, endedAtMs: number): void {
  if (process.platform !== "win32") return;
  const inCall = "$_.CreationDate -ge $from -and $_.CreationDate -le $to";
  const script = [
    `$from = [DateTimeOffset]::FromUnixTimeMilliseconds(${Math.floor(startedAtMs)}).LocalDateTime`,
    `$to = [DateTimeOffset]::FromUnixTimeMilliseconds(${Math.ceil(endedAtMs)}).LocalDateTime`,
    "$all = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate)",
    "$ids = [System.Collections.Generic.List[uint32]]::new()",
    `$queue = [System.Collections.Generic.Queue[uint32]]::new(); $queue.Enqueue(${Math.trunc(deadPid)})`,
    "while ($queue.Count) { $parent = $queue.Dequeue()",
    `  foreach ($p in @($all | Where-Object { $_.ParentProcessId -eq $parent -and ${inCall} })) {`,
    "    if (-not $ids.Contains($p.ProcessId)) { $ids.Add($p.ProcessId); $queue.Enqueue($p.ProcessId) } } }",
    "if ($ids.Count) { Stop-Process -Id $ids -Force -ErrorAction SilentlyContinue",
    "  Wait-Process -Id $ids -Timeout 5 -ErrorAction SilentlyContinue }",
  ].join("\n");
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  try {
    // Run from outside the repo, so the sweep itself holds nothing open there.
    execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
      cwd: tmpdir(), stdio: "ignore", windowsHide: true, timeout: 20_000,
    });
  } catch { /* best-effort: what it could not reach stays as it was */ }
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
 * The ONE home for detached-spawn tree-killing: process-session (killSession)
 * and the shell tool's abort handler both route here so the platform logic
 * can't drift between them.
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
