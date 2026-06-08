import { spawn, execFileSync, execFile } from "node:child_process";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { createLogger } from "../../../logger.js";
import { HOME, IS_WIN, TIERS, tierById, type VoiceTier } from "./tiers.js";
import { probeHealth } from "./detection.js";
import { running } from "./state.js";

const execFileAsync = promisify(execFile);

const logger = createLogger("routes.bridges.voice-setup");

const SIDECAR_LOG_DIR = join(HOME, ".lax", "sidecars");

export function sidecarLogPath(tierId: string): string {
  return join(SIDECAR_LOG_DIR, `${tierId}.log`);
}

/**
 * Open (append) the sidecar's log file and return its fd. Used as the
 * stdio target for spawn so that:
 *   1. The child's stdout/stderr aren't piped through the parent (a piped
 *      stream keeps the parent process tethered, so a tsx hot-reload would
 *      kill the child along with the parent).
 *   2. Logs survive across LAX restarts — admin can `tail -f` the file
 *      to debug a sidecar without needing the LAX server log.
 */
function openSidecarLogFd(tierId: string): number {
  if (!existsSync(SIDECAR_LOG_DIR)) mkdirSync(SIDECAR_LOG_DIR, { recursive: true });
  return openSync(sidecarLogPath(tierId), "a");
}

/**
 * Find the PID listening on a TCP port (Windows-only — uses
 * Get-NetTCPConnection). Used as a fallback so Stop can kill an orphan
 * sidecar from a previous LAX run that wasn't tracked in the running map.
 */
function pidOnPort(port: number): number | null {
  if (!IS_WIN) return null;
  try {
    const out = execFileSync("powershell", [
      "-NoProfile", "-Command",
      `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)`,
    ], { encoding: "utf-8", timeout: 5000, windowsHide: true }).trim();
    const pid = Number(out);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function killPid(pid: number): boolean {
  try {
    if (IS_WIN) {
      execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], { timeout: 5000, windowsHide: true, stdio: "ignore" });
    } else {
      process.kill(pid, "SIGTERM");
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Find every process matching a tier's command signature, regardless of
 * whether it's still listening on its port. This is what catches a sidecar
 * that crashed its HTTP server but didn't exit (CUDA OOM / driver deadlock) —
 * pidOnPort can't see it because it's no longer bound, but the python process
 * is still alive eating GPU. Matches on `tier.procMatch` (all substrings must
 * be present in the command line).
 */
interface SidecarProc { pid: number; ppid: number; }

async function findSidecarPids(tier: VoiceTier): Promise<SidecarProc[]> {
  const markers = tier.procMatch;
  if (!markers || markers.length === 0) return [];
  if (IS_WIN) {
    const conds = markers
      .map(m => `$_.CommandLine.ToLower().Contains('${m.toLowerCase().replace(/'/g, "''")}')`)
      .join(" -and ");
    const script =
      `Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue | ` +
      `Where-Object { $_.CommandLine -and ${conds} } | ` +
      `ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId)" }`;
    try {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { timeout: 10_000, windowsHide: true },
      );
      return parseProcLines(stdout);
    } catch {
      return [];
    }
  }
  // Unix: pgrep -f the most specific marker, then keep only PIDs whose full
  // command line contains every marker.
  try {
    const { stdout } = await execFileAsync("pgrep", ["-f", markers[markers.length - 1]], { timeout: 5000 });
    const pids = stdout.split(/\s+/).filter(s => /^\d+$/.test(s)).map(s => parseInt(s, 10));
    const out: SidecarProc[] = [];
    for (const pid of pids) {
      try {
        const { stdout: info } = await execFileAsync("ps", ["-p", String(pid), "-o", "ppid=,command="], { timeout: 3000 });
        const m = info.trim().match(/^(\d+)\s+(.*)$/);
        if (m && markers.every(k => m[2].toLowerCase().includes(k.toLowerCase()))) out.push({ pid, ppid: parseInt(m[1], 10) });
      } catch { /* gone */ }
    }
    return out;
  } catch {
    return [];
  }
}

function parseProcLines(stdout: string): SidecarProc[] {
  const out: SidecarProc[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+),(\d+)$/);
    if (m) out.push({ pid: parseInt(m[1], 10), ppid: parseInt(m[2], 10) });
  }
  return out;
}

/**
 * Expand a set of root pids to include their descendants WITHIN `procs`. The
 * venv launcher LAX tracks (`running` pid) spawns the real python worker as a
 * child; for SoVITS both match the same signature because "sovits" is in the
 * script path, so a naive keep-the-tracked-pid kills the worker. Keeping the
 * tracked pid's subtree spares the worker the launcher actually owns.
 */
function withDescendants(procs: SidecarProc[], roots: Iterable<number>): Set<number> {
  const keep = new Set<number>();
  for (const r of roots) if (r) keep.add(r);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of procs) {
      if (!keep.has(p.pid) && keep.has(p.ppid)) { keep.add(p.pid); grew = true; }
    }
  }
  return keep;
}

/**
 * Sweep every sidecar tier for orphan processes and kill them. Safe to run
 * on a timer: it never touches a sidecar THIS instance is tracking (the
 * `running` map — populated the instant we spawn, so a 90-120s cold-starting
 * sidecar is protected). For each tier it keeps either the process we own or
 * the single healthy one currently bound to the port (adopt-across-restart),
 * and tree-kills everything else. Returns the number reaped.
 */
export async function reapOrphanSidecars(): Promise<number> {
  let killed = 0;
  for (const tier of TIERS) {
    if (tier.kind === "native" || !tier.procMatch || tier.port <= 0) continue;
    const procs = await findSidecarPids(tier);
    if (procs.length === 0) continue;
    const mine = running.get(tier.id)?.pid ?? null;
    const onPort = pidOnPort(tier.port);
    const healthy = (await probeHealth(tier.healthUrl)).ok;
    // A responding /healthz means a working server is serving this port — the
    // reaper is for hung/orphan processes, not live ones. If we can't pin the
    // listener's pid (pidOnPort is racy: a transient PowerShell failure returns
    // null) and we don't own it, skip the tier entirely rather than blind-kill
    // every matching pid — that blind kill was taking down healthy sidecars.
    if (healthy && !onPort && !mine) continue;
    // Keep the owned/listening process AND its child subtree: the tracked pid
    // is the venv launcher, the real worker is its child and matches the same
    // signature, so keeping only the root would kill the worker.
    const keep = withDescendants(procs, [mine ?? 0, onPort ?? 0]);
    for (const { pid } of procs) {
      if (keep.has(pid)) continue;
      if (killPid(pid)) {
        killed++;
        logger.info(`[voice-setup] reaped orphan ${tier.id} pid=${pid} (port ${tier.port}, healthy=${healthy})`);
      }
    }
  }
  return killed;
}

/**
 * Start one tier's sidecar and block until /healthz reports OK or the
 * 3-min deadline passes. Returns true on healthy start, false on timeout.
 *
 * If a sidecar is already responding on the tier's port (left over from a
 * previous LAX run because we now spawn detached), adopt it — skip the spawn
 * and return true. This prevents starting two sidecars on the same port and
 * makes the picker resilient to LAX hot-reloads.
 */
export async function startTierAndWait(tier: VoiceTier): Promise<boolean> {
  // Adopt an existing healthy sidecar instead of double-spawning.
  const existing = await probeHealth(tier.healthUrl);
  if (existing.ok) {
    logger.info(`[voice-setup] ${tier.id}: already running on ${tier.port}, adopting`);
    return true;
  }
  killTier(tier.id);
  const cmd = tier.startCmd();
  logger.info(`[voice-setup] Starting ${tier.id}: ${cmd.command} ${cmd.args.join(" ")}`);
  // Detach + log-file stdio: the child must outlive a tsx hot-reload of the
  // parent, so we (a) inherit no pipes (would tether parent), (b) detached:true
  // so the child becomes its own process group, and (c) unref() so the parent
  // event loop doesn't wait on it during shutdown.
  const logFd = openSidecarLogFd(tier.id);
  const proc = spawn(cmd.command, cmd.args, {
    cwd: cmd.cwd,
    env: cmd.env,
    stdio: ["ignore", logFd, logFd],
    detached: true,
    windowsHide: true,
  });
  proc.unref();
  running.set(tier.id, proc);
  proc.on("exit", code => { logger.info(`[voice-setup] ${tier.id} exited (${code}) — see ${sidecarLogPath(tier.id)}`); if (running.get(tier.id) === proc) running.delete(tier.id); });
  // Cold-start is heavy: faster-whisper large-v3-turbo + Kokoro + Silero
  // VAD on first CUDA load can take 90-120s. Subsequent starts after OS
  // file cache is warm are <20s.
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) return false;
    const h = await probeHealth(tier.healthUrl);
    if (h.ok) return true;
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

export function killTier(tierId: string): void {
  const proc = running.get(tierId);
  if (proc && proc.exitCode === null) {
    try { proc.kill(); } catch {}
  }
  running.delete(tierId);
  // Detached children from a previous LAX run aren't in the map. Find them
  // by port and kill so Stop is reliable across restarts.
  const tier = tierById(tierId);
  if (tier && tier.kind !== "native" && tier.port > 0) {
    const orphan = pidOnPort(tier.port);
    if (orphan) {
      logger.info(`[voice-setup] killing orphan ${tierId} pid=${orphan} on port ${tier.port}`);
      killPid(orphan);
    }
    // Also sweep by command signature: a sidecar that crashed its HTTP server
    // but didn't exit is no longer on the port, so pidOnPort missed it above.
    // Fire-and-forget (killTier is sync; callers don't await death). Skip
    // whatever's in the running map at resolution time so a replacement that
    // startTierAndWait spawns right after this call isn't killed.
    if (tier.procMatch) {
      void findSidecarPids(tier).then(procs => {
        // Spare the tracked launcher AND its worker subtree (see withDescendants).
        const keep = withDescendants(procs, [running.get(tierId)?.pid ?? 0]);
        const victims = procs.map(p => p.pid).filter(pid => !keep.has(pid));
        if (victims.length) logger.info(`[voice-setup] killTier ${tierId} sweep: keep=[${[...keep].join(",")}] killing=[${victims.join(",")}]`);
        for (const pid of victims) killPid(pid);
      }).catch(() => {});
    }
  }
}

// NOTE: deliberately no kill-children-on-parent-exit handler. Sidecars are
// detached so they survive a tsx hot-reload — if we killed them on parent
// exit, every src/ edit during dev would tear down the user's GPU sidecars
// (which take 30-90s to cold-start). Sidecars are stopped explicitly via the
// Stop button; orphans from a crash are reaped two ways: killTier's port +
// signature sweep when the user clicks Start/Stop, and reapOrphanSidecars()
// running at boot and on a 60s timer (wired in src/index.ts) so hung
// processes get cleaned automatically without any user action.
