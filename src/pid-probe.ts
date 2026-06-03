// Verify whether a PID belongs to OUR server process — not just whether
// something is alive at that PID number.
//
// Why this exists: `process.kill(pid, 0)` only answers "is *some* process
// alive at this PID?". Windows recycles PIDs aggressively — within hours
// of a process exiting, the OS will reassign that PID to an unrelated
// process (svchost, chrome, etc.). A stale pidfile pointing at a recycled
// PID would then read as "our server is already running", so we'd refuse
// to boot or skip orphan cleanup.
//
// The fix: pair liveness with an image-name check. If the live process
// at that PID isn't node, the pidfile is stale and should be discarded.
//
// MIRROR: keep identical to desktop/src/pid-probe.ts. Both copies exist
// because src/ (ESM, tsx-loaded) and desktop/src/ (CJS, tsc-built) compile
// separately and can't cross-import.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Pure liveness probe. Returns true iff *some* process owns this PID.
 *  Use this when identity doesn't matter — e.g. polling for a kill to
 *  complete, or watching whether our parent process is still up. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** True iff the PID is alive AND the process at that PID is node. Use
 *  this when reading a pidfile to decide whether the previous server is
 *  genuinely still running (refuse boot / kill orphan) vs. the PID has
 *  been recycled to an unrelated process (delete stale pidfile, proceed). */
export function isOurServerProcess(pid: number): boolean {
  if (!isPidAlive(pid)) return false;
  const image = getProcessImage(pid);
  if (!image) return false;
  return /^node(\.exe)?$/i.test(image);
}

function getProcessImage(pid: number): string | null {
  try {
    if (process.platform === "win32") {
      // tasklist is always present and faster than wmic or PowerShell.
      // CSV row: "ImageName","PID","SessionName","Session#","MemUsage".
      // Empty output (or non-zero exit) when the PID isn't running.
      const out = execSync(
        `tasklist /FI "PID eq ${pid}" /FO CSV /NH`,
        { windowsHide: true, timeout: 2000, stdio: ["ignore", "pipe", "ignore"] },
      ).toString();
      const m = out.match(/^"([^"]+)"/m);
      return m ? m[1] : null;
    }
    if (process.platform === "linux") {
      // /proc/<pid>/comm holds the basename, but a process can rename it via
      // its title (worker pools, vitest's forks runner do this). Trust comm
      // when it already names our binary; otherwise fall back to the real
      // executable from cmdline[0], which a title change can't alter.
      const comm = readFileSync(`/proc/${pid}/comm`, "utf-8").trim();
      if (/^node$/i.test(comm)) return comm;
      try {
        const argv0 = readFileSync(`/proc/${pid}/cmdline`, "utf-8").split("\0")[0];
        if (argv0) return argv0.split(/[\\/]/).pop() || comm || null;
      } catch {
        // cmdline unreadable — fall back to comm below.
      }
      return comm || null;
    }
    // macOS / BSD: ps -o comm= prints just the command field, no header.
    const out = execSync(
      `ps -p ${pid} -o comm=`,
      { timeout: 2000, stdio: ["ignore", "pipe", "ignore"] },
    ).toString().trim();
    if (!out) return null;
    // macOS prints the full path; reduce to basename.
    return out.split(/[\\/]/).pop() || null;
  } catch {
    return null;
  }
}
