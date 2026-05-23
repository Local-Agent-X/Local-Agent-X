import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../../../logger.js";
import { HOME, IS_WIN, tierById, type VoiceTier } from "./tiers.js";
import { probeHealth } from "./detection.js";
import { running } from "./state.js";

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
  }
}

// NOTE: deliberately no kill-children-on-parent-exit handler. Sidecars are
// detached so they survive a tsx hot-reload — if we killed them on parent
// exit, every src/ edit during dev would tear down the user's GPU sidecars
// (which take 30-90s to cold-start). Sidecars are stopped explicitly via the
// Stop button; orphans from a real crash are reaped by killTier's port-PID
// fallback the next time the user clicks Start or Stop.
