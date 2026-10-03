import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { createLogger } from "../logger.js";
import { getRuntimeConfig, saveConfig } from "../config.js";
import { getLaxDir } from "../lax-data-dir.js";
import type { SandboxMode } from "./types.js";
import { isSeatbeltAvailable, seatbeltProfileLoads, wrapForSeatbelt } from "./seatbelt.js";
import { isBwrapAvailable, bwrapEnforces, bwrapGuardedRuns, wrapForBwrap } from "./bwrap.js";
import { currentShellEgressBridge } from "../net/shell-egress-proxy.js";
import { onWinCageProofSettled, resolveWinCageHelper, winCageEnforces, winCageEnforcesSync, winCageProbePending, winCageProofView, winCageUnusableReason, wrapForWinCage } from "./win-cage.js";
import { ensureWinCageGrantsSync, WinCageGrantFailedError, WinCageGrantPendingError } from "./win-cage-grants.js";
import { isDockerAvailable } from "./docker-shell.js";
import { beginApprovalWait } from "../approval-wait.js";
import { resolveWindowsShell } from "../tools/shell-env.js";
export { ensureWinCageGrants } from "./win-cage-grants.js";
export { execInSandbox, isDockerAvailable } from "./docker-shell.js";
const logger = createLogger("sandbox");

export type { SandboxMode } from "./types.js";
export { validateSandboxConfig } from "./validate.js";
// Denial→truthful-notice mapping lives in denial-hints.ts (split when the
// network hint pushed this file past the 400-LOC bar); re-exported so callers
// keep importing from the sandbox facade.
export { sandboxDenialHint, networkDenialHint } from "./denial-hints.js";

// Memoized: whether seatbelt is usable on THIS host (macOS + sandbox-exec
// present + our generated profile actually loads). Deterministic per process,
// and seatbeltProfileLoads() spawns sandbox-exec, so probe once.
let seatbeltUsable: boolean | null = null;
function isSeatbeltUsable(): boolean {
  if (seatbeltUsable === null) {
    seatbeltUsable = isSeatbeltAvailable() && seatbeltProfileLoads();
  }
  return seatbeltUsable;
}

// Memoized: whether bwrap is usable on THIS host (Linux + bwrap on PATH +
// the cage empirically holds — bwrapEnforces() runs a real confined probe,
// so probe once).
let bwrapUsable: boolean | null = null;
function isBwrapUsable(): boolean {
  if (bwrapUsable === null) {
    bwrapUsable = isBwrapAvailable() && bwrapEnforces();
  }
  return bwrapUsable;
}

// Memoized: whether the GUARDED default cage (credential deny, network kept) is
// usable on THIS host — macOS via seatbelt, Linux via bwrap. Separate from the
// strict-mode checks above: guarded keeps network, so the bwrap probe is the
// build-only bwrapGuardedRuns (NOT bwrapEnforces, which requires net-blocked).
let guardedUsable: boolean | null = null;
export function isGuardedUsable(): boolean {
  // Windows: the opt-in user+WFP cage, usable only once its fence is proven.
  // The proof runs off the event loop after the first ask and answers "not
  // yet" until it lands. win-cage.ts memoizes it and forgets it on install or
  // uninstall, so it is read through here: a second cache would keep the
  // pre-install answer until a restart.
  if (process.platform === "win32") return resolveWinCageHelper() !== null && winCageEnforcesSync();
  if (guardedUsable === null) {
    if (process.platform === "darwin") guardedUsable = isSeatbeltAvailable() && seatbeltProfileLoads(undefined, "guarded");
    else if (process.platform === "linux") guardedUsable = isBwrapAvailable() && bwrapGuardedRuns();
    else guardedUsable = false;
  }
  return guardedUsable;
}

// Runtime override — set via API, persists in memory for this process
let runtimeMode: SandboxMode | null = null;

export interface SandboxStatus {
  selectedMode: SandboxMode;
  effectiveMode: SandboxMode;
  confined: boolean;
  fallbackReason?: string;
  /** Guarded is selected on Windows and the cage's fence proof is still
   *  running: nothing is confined yet, and no shell spawns until it lands. */
  proofPending: boolean;
  unconfinedHostAcknowledged: boolean;
  cronShellAllowed: boolean;
  delegatedShellAllowed: boolean;
  apiShellAllowed: boolean;
}

function acknowledgementPath(): string {
  return join(getLaxDir(), "sandbox-host-acknowledgement.json");
}

export function isUnconfinedHostAcknowledged(): boolean {
  const path = acknowledgementPath();
  if (!existsSync(path)) return false;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as { acknowledged?: unknown; selectedMode?: unknown };
    return parsed.acknowledged === true && parsed.selectedMode === getSelectedSandboxMode();
  } catch (e) {
    logger.warn(`[sandbox] Failed to read host acknowledgement: ${(e as Error).message}`);
    return false;
  }
}

export function setUnconfinedHostAcknowledgement(acknowledged: boolean): void {
  const path = acknowledgementPath();
  if (!acknowledged) {
    if (existsSync(path)) unlinkSync(path);
    return;
  }
  mkdirSync(getLaxDir(), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp.${randomBytes(4).toString("hex")}`;
  try {
    writeFileSync(tmp, JSON.stringify({ acknowledged: true, selectedMode: getSelectedSandboxMode(), acknowledgedAt: new Date().toISOString() }, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* cleanup failure does not replace the persistence error */ }
    throw e;
  }
}

function getSelectedSandboxMode(): SandboxMode {
  if (runtimeMode) return runtimeMode;
  const envMode = (process.env.LAX_SANDBOX ?? "").toLowerCase();
  if (envMode === "host" || envMode === "disabled" || envMode === "off" || envMode === "none" || envMode === "false") return "host";
  if (envMode === "guarded" || envMode === "docker" || envMode === "seatbelt" || envMode === "bwrap") return envMode;
  try {
    return getRuntimeConfig().sandboxMode;
  } catch {
    return "guarded";
  }
}

export function getSandboxStatus(): SandboxStatus {
  const selectedMode = getSelectedSandboxMode();
  let effectiveMode = selectedMode;
  let fallbackReason: string | undefined;
  let proofPending = false;

  if (selectedMode === "docker" && !isDockerAvailable()) {
    effectiveMode = "host";
    fallbackReason = "Docker is unavailable, so bash fell back to the unconfined host.";
  } else if (selectedMode === "guarded" && !isGuardedUsable()) {
    effectiveMode = "host";
    proofPending = process.platform === "win32" && winCageProbePending();
    if (proofPending) fallbackReason = "The Windows shell cage is being verified; shell commands wait for it.";
    else fallbackReason = process.platform === "win32"
      ? `The Windows network cage is not active (${winCageUnusableReason() ?? "not proven"}), so bash is unconfined.`
      : "The guarded kernel cage is unavailable on this host, so bash is unconfined.";
  } else if (selectedMode === "seatbelt" && !isSeatbeltUsable()) {
    effectiveMode = "host";
    fallbackReason = "sandbox-exec is unavailable, so bash fell back to the unconfined host.";
  } else if (selectedMode === "bwrap" && !isBwrapUsable()) {
    effectiveMode = "host";
    fallbackReason = "bubblewrap is unavailable, so bash fell back to the unconfined host.";
  }

  const confined = effectiveMode !== "host";
  const unconfinedHostAcknowledged = isUnconfinedHostAcknowledged();
  const unattendedHostAllowed = confined || unconfinedHostAcknowledged;
  return {
    selectedMode,
    effectiveMode,
    confined,
    ...(fallbackReason ? { fallbackReason } : {}),
    proofPending,
    unconfinedHostAcknowledged,
    cronShellAllowed: false,
    delegatedShellAllowed: unattendedHostAllowed,
    apiShellAllowed: unattendedHostAllowed,
  };
}

/**
 * Get the current sandbox configuration.
 * Priority: runtime override > env var > auto-detect.
 */
export function getSandboxMode(): SandboxMode {
  return getSandboxStatus().effectiveMode;
}

/** What every refusal made while the Windows fence proof runs says: the spawn
 *  seam, process_restart, the unattended and delegated shell gates. */
export const SANDBOX_PROOF_PENDING_RETRY = "The Windows shell cage is still being verified; try again in a few seconds.";

/** Thrown by wrapSpawnForSandbox while the Windows fence proof runs. Retryable. */
export class SandboxProofPendingError extends Error {
  constructor() {
    super(`${SANDBOX_PROOF_PENDING_RETRY} Nothing was started: until the check finishes, a command would run outside the cage.`);
    this.name = "SandboxProofPendingError";
  }
}

/** How long a spawn path that can wait gives a pending Windows fence proof. */
export const SANDBOX_PROOF_WAIT_MS = 60_000;

/**
 * Wait, bounded, for a pending Windows fence proof, so an async spawn path runs
 * under the settled answer (caged when proven, the visible host fallback when
 * it failed) instead of being refused. A proof still running after the bound
 * leaves the refusal to wrapSpawnForSandbox. An abort ends the wait at once;
 * the caller reads its own signal. The wait is booked as time the tool was not
 * working (approval-wait.ts), so the harness's backstop does not count it
 * against the command. `onWait` runs only when there is a wait.
 */
export async function awaitSandboxProof(opts: { signal?: AbortSignal; onWait?: () => void; timeoutMs?: number } = {}): Promise<void> {
  if (process.platform !== "win32" || opts.signal?.aborted) return;
  if (getSelectedSandboxMode() !== "guarded" || !getSandboxStatus().proofPending) return;
  opts.onWait?.();
  const endWait = beginApprovalWait();
  let timer: NodeJS.Timeout | undefined;
  let release!: () => void;
  const bound = new Promise<void>((resolve) => { release = resolve; timer = setTimeout(resolve, opts.timeoutMs ?? SANDBOX_PROOF_WAIT_MS); });
  opts.signal?.addEventListener("abort", release, { once: true });
  try {
    await Promise.race([winCageEnforces(), bound]);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", release);
    endWait();
  }
}

// The server's reaction to a landed proof (startSandboxProof). Kept so the
// proof it missed reaches it too: one that landed before it was registered
// (anything that read the sandbox status at boot starts the proof), and one
// that landed while another mode was selected, when guarded is chosen later.
let proofSettledListener: (() => void) | null = null;

/**
 * Boot: start the Windows fence proof now (it runs in a child process) rather
 * than on the first ask, so it has normally landed before the first shell
 * command. `onSettled` runs whenever a proof lands, this one or a later one
 * after an install, and at once when the proof had already landed, here or
 * when guarded is chosen afterwards. The server starts the sandbox user's
 * grants over in the background and re-broadcasts the sandbox status from it.
 * A listener that missed its proof leaves the first caged command to start the
 * grant and pay for it, and a start that cannot wait (a dev server's) refused,
 * retryably, until the grant is done.
 */
export function startSandboxProof(onSettled: () => void): void {
  proofSettledListener = onSettled;
  onWinCageProofSettled(onSettled);
  replayLandedProof();
}

/** With guarded selected on Windows: start the proof, or, when it has already
 *  landed (the listener is called only as it lands), run the listener now. */
function replayLandedProof(): void {
  if (process.platform !== "win32" || getSelectedSandboxMode() !== "guarded" || resolveWinCageHelper() === null) return;
  winCageEnforcesSync();
  if (!winCageProbePending()) proofSettledListener?.();
}

/**
 * The sandbox user's grants as the settings page shows them while the Windows
 * cage is in use. Asked of the seam a caged start goes through, so the page
 * says what such a start meets (and, as that start does, sets the grants going
 * if nothing has): still being made, so it is refused, retryably; or failed,
 * so every caged command is refused, with the reason and what to do about it.
 */
export function winCageGrantView(): { grantPending?: true; grantFailure?: string } {
  if (process.platform !== "win32" || getSandboxMode() !== "guarded") return {};
  try {
    ensureWinCageGrantsSync(resolveWindowsShell().path);
  } catch (e) {
    if (e instanceof WinCageGrantFailedError) return { grantFailure: e.message };
    if (e instanceof WinCageGrantPendingError) return { grantPending: true };
    throw e;
  }
  return {};
}

/**
 * Wrap an intended `(shell, shellArgs)` spawn for the active sandbox mode.
 * In "seatbelt" mode it returns the sandbox-exec invocation; in every other
 * mode it returns the pair unchanged. Callers (bash, process_start) wrap
 * unconditionally and spawn the result — the host/docker paths are untouched.
 * `childEnv` is the env the caller will spawn with; the Windows cage passes it
 * to the sandboxed child explicitly (the child does not inherit the broker's).
 */
export function wrapSpawnForSandbox(shell: string, shellArgs: string[], childEnv: Record<string, string> = {}): { cmd: string; args: string[] } {
  const status = getSandboxStatus();
  // Fail closed: while the Windows fence proof runs, the effective mode reads
  // "host", and a spawn here would put the first commands after a start
  // outside a cage that is about to be proven. Every shell spawn the mode
  // governs (bash, process_*, dev servers) wraps through this function, so
  // this one check covers them all; the ones that can wait call
  // awaitSandboxProof first.
  if (status.proofPending) throw new SandboxProofPendingError();
  const mode = status.effectiveMode;
  if (mode === "seatbelt") {
    return wrapForSeatbelt(shell, shellArgs);
  }
  if (mode === "bwrap") {
    return wrapForBwrap(shell, shellArgs);
  }
  if (mode === "guarded") {
    // Default cage: credential deny, network only through the egress proxy.
    // The status read above only says "guarded" when a backend is usable, so
    // pick the platform's. On Linux the shell gets its own network namespace
    // and the proxy's unix socket as its one way out; no socket yet (the proxy
    // is still warming) means no route, which is the fail-closed side.
    if (isSeatbeltAvailable()) return wrapForSeatbelt(shell, shellArgs, undefined, "guarded");
    if (isBwrapAvailable()) {
      const bridge = currentShellEgressBridge();
      return wrapForBwrap(shell, shellArgs, undefined, "guarded", { network: "namespace", ...(bridge ? { bridge } : {}) });
    }
    const helper = process.platform === "win32" ? resolveWinCageHelper() : null;
    if (helper) {
      // Never grants here: on the event loop that froze every request for as
      // long as the workspace took to stamp. Until the background grant
      // started when the proof landed is done this refuses, retryably, and
      // once it failed it refuses with the reason; nothing is started either way.
      ensureWinCageGrantsSync(shell);
      return wrapForWinCage(shell, shellArgs, childEnv, helper);
    }
    // A backend gone since the status read (the helper deleted mid-run) must
    // not turn a guarded spawn into a host one.
    throw new Error(process.platform === "win32"
      ? "The Windows shell cage's helper (srt-win.exe) is no longer where the cage was proven, so nothing was started. Reinstall the cage from Settings → Security."
      : "The guarded shell cage's backend is no longer available, so nothing was started.");
  }
  return { cmd: shell, args: shellArgs };
}

/** Why guarded cannot be selected here. On Windows an installed cage that
 *  failed its fence proof needs repair, not the install the other cases do. */
function guardedUnavailableError(): string {
  if (process.platform !== "win32") return "The kernel cage is not available on this machine (needs macOS, or Linux with unprivileged user namespaces) — bash runs unconfined here.";
  if (winCageProbePending()) return SANDBOX_PROOF_PENDING_RETRY;
  const broken = winCageProofView().proofFailure;
  if (broken) return `The Windows network cage is installed but not working (${broken}) — bash runs unconfined until it passes its check; remove and reinstall it from Settings → Security.`;
  return `The Windows network cage is not active (${winCageUnusableReason() ?? "not proven"}) — install it from Settings → Security first; bash runs unconfined until then.`;
}

/** Set sandbox mode at runtime (from settings API). Persists to ~/.lax/config.json. */
export function setSandboxMode(mode: SandboxMode): { ok: boolean; actual: SandboxMode; error?: string } {
  if (mode === "docker" && !isDockerAvailable()) {
    return { ok: false, actual: "host", error: "Docker is not installed or not running. Install Docker Desktop first." };
  }
  if (mode === "seatbelt" && !isSeatbeltUsable()) {
    return { ok: false, actual: "host", error: "Kernel sandbox (sandbox-exec) is not available on this machine — it requires macOS." };
  }
  if (mode === "bwrap" && !isBwrapUsable()) {
    return { ok: false, actual: "host", error: "Namespace sandbox (bwrap) is not usable on this machine — it requires Linux with bubblewrap installed and unprivileged user namespaces enabled." };
  }
  if (mode === "guarded" && !isGuardedUsable()) {
    return { ok: false, actual: "host", error: guardedUnavailableError() };
  }
  const previous = getSelectedSandboxMode();
  runtimeMode = mode;
  try {
    const cfg = getRuntimeConfig();
    cfg.sandboxMode = mode;
    saveConfig(cfg);
  } catch (e) {
    logger.warn(`[sandbox] Failed to persist mode to config: ${(e as Error).message}`);
  }
  // Guarded is chosen only once the proof has landed, and when it landed
  // under another mode the listener found the cage out of use and granted
  // nothing.
  if (mode === "guarded" && previous !== "guarded") replayLandedProof();
  logger.info(`[sandbox] Mode set to: ${mode}`);
  return { ok: true, actual: mode };
}
