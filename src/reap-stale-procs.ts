import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createLogger } from "./logger.js";

const execFileAsync = promisify(execFile);

export interface StaleProcMatch {
  /** OS image names to scan (Windows Get-CimInstance filter; ignored on Unix,
   *  where pgrep -f matches the command line directly). */
  processNames: string[];
  /** Kill only processes whose full command line contains this substring
   *  (case-insensitive). Scopes the sweep to one install/profile. */
  cmdlineContains: string;
  /** If set, kill only processes that started before this instant — so a
   *  freshly-spawned sibling (e.g. the warm pool's own children) is spared. */
  olderThan?: Date;
  /** Logger scope label. */
  label: string;
}

/**
 * Build the PowerShell scan script that lists PIDs matching the criteria.
 * Pure (no IO) so the escaping + age-guard logic is unit-testable. Exported
 * for tests only.
 *
 * Backslashes stay literal: a PowerShell single-quoted string treats only the
 * quote as special (doubled), so a real Windows path like
 * `c:\users\…\mcp-bridge` must NOT be backslash-escaped or the `.Contains`
 * match silently never fires (the bug the old Chrome reaper shipped).
 */
export function buildWin32ScanScript(opts: StaleProcMatch): string {
  const nameFilter = opts.processNames.map((n) => `Name='${n}'`).join(" OR ");
  const cutoffMs = opts.olderThan?.getTime();
  const ageGuard = cutoffMs !== undefined
    ? ` -and ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() -lt ${cutoffMs}`
    : "";
  const needle = opts.cmdlineContains.toLowerCase().replace(/'/g, "''");
  return (
    `Get-CimInstance Win32_Process -Filter "${nameFilter}" -ErrorAction SilentlyContinue | ` +
    `Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains('${needle}')${ageGuard} } | ` +
    `Select-Object -ExpandProperty ProcessId`
  );
}

/**
 * Find and force-kill every process matching `processNames` whose command line
 * contains `cmdlineContains` (and, if given, that started before `olderThan`).
 * Returns the killed PIDs. Non-fatal: a scan failure logs a warning and
 * returns []. Shared engine behind the boot-time orphan reapers (stale agent
 * Chrome in browser/cleanup-stale.ts, stale mcp-bridge children below).
 */
export async function findAndKillProcesses(opts: StaleProcMatch): Promise<number[]> {
  const logger = createLogger(opts.label);
  const cutoffMs = opts.olderThan?.getTime();
  const killed: number[] = [];

  if (process.platform === "win32") {
    const script = buildWin32ScanScript(opts);
    try {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { timeout: 10_000, windowsHide: true },
      );
      for (const pid of parsePids(stdout)) {
        try { process.kill(pid); killed.push(pid); } catch { /* exited between scan and kill */ }
      }
    } catch (e) {
      logger.warn(`process scan failed (non-fatal): ${(e as Error).message}`);
    }
    return killed;
  }

  // Unix: pgrep -f matches against the full command line; age-filter via ps.
  try {
    const { stdout } = await execFileAsync("pgrep", ["-f", opts.cmdlineContains], { timeout: 5_000 });
    for (const pid of parsePids(stdout)) {
      if (cutoffMs !== undefined && !(await startedBefore(pid, cutoffMs))) continue;
      try { process.kill(pid); killed.push(pid); } catch { /* gone */ }
    }
  } catch {
    // pgrep exits non-zero on no match — the common case.
  }
  return killed;
}

function parsePids(stdout: string): number[] {
  return stdout
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s))
    .map((s) => parseInt(s, 10));
}

async function startedBefore(pid: number, cutoffMs: number): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "etimes=", "-p", String(pid)], { timeout: 5_000 });
    const etimes = parseInt(stdout.trim(), 10);
    if (!Number.isFinite(etimes)) return false;
    return Date.now() - etimes * 1000 < cutoffMs;
  } catch {
    return false;
  }
}

/**
 * Kill mcp-bridge subprocesses orphaned by a previous server lifetime.
 *
 * Why: the Claude CLI we spawn loads our generated --mcp-config, which starts
 * `node …/mcp-bridge.{ts,js}` as a stdio child. On Windows the CLI runs under a
 * cmd.exe shell wrapper, so a teardown that signals only the wrapper leaves the
 * bridge reparented and alive. They pile up across launches until handle/port
 * contention wedges the next boot — the recurring "won't load" hang.
 *
 * SAFETY: scoped to THIS install's bridge script path AND to processes that
 * predate the current server (olderThan = our start time), so the warm pool's
 * own freshly-spawned bridges are never caught.
 */
export async function cleanupStaleMcpBridges(): Promise<void> {
  const logger = createLogger("mcp-cleanup");
  const here = dirname(fileURLToPath(import.meta.url));
  // src/reap-stale-procs.ts → src/mcp-bridge. Extensionless so both the tsx
  // (.ts) and compiled (.js) forms are matched, mirroring mcp-config.ts.
  const bridgePath = resolve(join(here, "mcp-bridge"));
  const startedAt = new Date(Date.now() - process.uptime() * 1000);
  logger.info(`[mcp-cleanup] scanning for stale mcp-bridge processes under ${bridgePath}`);
  const killed = await findAndKillProcesses({
    processNames: ["node.exe"],
    cmdlineContains: bridgePath,
    olderThan: startedAt,
    label: "mcp-cleanup",
  });
  if (killed.length > 0) {
    logger.info(`[mcp-cleanup] killed ${killed.length} stale mcp-bridge process(es): PIDs ${killed.join(", ")}`);
  } else {
    logger.info(`[mcp-cleanup] no stale mcp-bridge processes found`);
  }
}
