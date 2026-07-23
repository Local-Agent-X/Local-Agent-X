/**
 * Shared dev-server readiness: bind-probe, port reclaim, and startup-failure
 * capture.
 *
 * ONE implementation of "did the spawned dev server actually bind its port, or
 * did it crash?" used by BOTH entry points so they can't drift:
 *   - the agent-facing app_serve_* tools (dev-server-tools.ts), which block on
 *     it before claiming a backend is ready, and
 *   - the lazy restart in ensureDevServerRunning (dev-server.ts), which fires
 *     verifyDevServerStartup non-blocking to CAPTURE the failure (the
 *     idle-sweep-then-reopen path that previously logged "(re)started" and then
 *     silently 502'd, with the child's stderr lost to session eviction).
 *
 * Leaf module (imports only process-session, process-tree-kill, and logging
 * plumbing) so both callers can import it without a cycle.
 */
import { mkdirSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SESSIONS, sleep, tailLines, pidsOnPort } from "./process-session.js";
import { killProcessGroupSync } from "../process-tree-kill.js";
import { getLaxDir } from "../lax-data-dir.js";
import { createLogger } from "../logger.js";

const logger = createLogger("tools.dev-server");

export type BackendOutcome =
  | { status: "listening" }
  | { status: "crashed"; code: number | null; signal: NodeJS.Signals | null; output: string }
  | { status: "timeout"; output: string };

const BACKEND_POLL_MS = 400;

/** Human descriptor for how a process died — a signal name when killed by one
 *  (the "code null" case), else the numeric exit code. One formatter so the
 *  tool messages and the persisted diagnostic can't drift. */
export function exitDescriptor(code: number | null, signal: NodeJS.Signals | null): string {
  return signal ? `killed by ${signal}` : `code ${code}`;
}

/** Tail of a session's captured output (stderr preferred), for a failure report. */
function sessionOutput(sessionId: string, lines = 20): string {
  const s = SESSIONS.get(sessionId);
  return s ? tailLines(s.stderr || s.stdout || "", lines).trim() : "";
}

/** Poll until the server binds its port, the process exits, or we time out — so
 *  no caller ever treats a dead/never-bound server as running. Both the crashed
 *  and timeout outcomes carry the child's captured output so the caller can
 *  surface (or persist) the actual cause. */
export async function waitForBackend(sessionId: string, port: number, timeoutMs: number): Promise<BackendOutcome> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(BACKEND_POLL_MS);
    const s = SESSIONS.get(sessionId);
    if (s && s.exitedAt) {
      return { status: "crashed", code: s.exitCode, signal: s.exitSignal, output: tailLines(s.stderr || s.stdout || "", 20).trim() };
    }
    if (pidsOnPort(port).length > 0) return { status: "listening" };
  }
  return { status: "timeout", output: sessionOutput(sessionId) };
}

/**
 * Free a dev port held by processes this LAX server doesn't track — the orphan
 * class: a dev server that outlived the LAX process that spawned it (hard kill,
 * or an exit-time cleanup that couldn't run). Spawning a replacement without
 * reclaiming makes every `--strictPort` respawn die instantly against the
 * orphan while the port probe reads "listening" — one doomed spawn per request,
 * forever (the restart storm). Synchronous, so the caller can spawn immediately
 * after and the new child finds the port free. Never kills our own pid.
 * Returns the pids killed.
 */
export function reclaimPort(port: number): number[] {
  const holders = pidsOnPort(port).filter((pid) => pid !== process.pid);
  for (const pid of holders) killProcessGroupSync(pid);
  return holders;
}

/** How long the lazy-restart verifier waits for a re-spawned dev server to bind.
 *  Matches the frontend serve timeout so a slow (but fine) cold `npm install`
 *  isn't falsely reported; a crash returns immediately regardless. */
const LAZY_RESTART_VERIFY_MS = 60_000;

/** A bound port doesn't prove OUR child bound it: a foreign process holding the
 *  port makes a doomed `--strictPort` respawn look "listening" for the ~1s it
 *  takes to die. After a listening verdict, re-check once past this delay:
 *  session dead by then means the verdict was the foreign process's port. */
const LISTENING_FLAP_RECHECK_MS = 3_000;

/** Where a failed lazy restart's diagnostic (the child's captured stderr) is
 *  persisted. Server-side only, NOT under workspace/apps/<id>/. */
function devServerLogPath(appId: string): string {
  return join(getLaxDir(), "logs", "dev-servers", `${appId}.log`);
}

/** Turn a non-listening readiness outcome into a human diagnostic. Pure, so the
 *  format is unit-testable without spawning a real process. */
export function formatStartupFailure(appId: string, sessionId: string, port: number, outcome: BackendOutcome): string {
  const head = `lazy restart of dev server "${appId}" (session ${sessionId}) FAILED`;
  const body =
    outcome.status === "crashed"
      ? `process exited (${exitDescriptor(outcome.code, outcome.signal)}) without binding port ${port}`
      : `process did NOT bind port ${port} within ${LAZY_RESTART_VERIFY_MS / 1000}s`;
  const out = outcome.status === "listening" ? "" : outcome.output;
  return `${head}: ${body}` + (out ? `\n--- output (tail) ---\n${out}` : "\n(no output captured)");
}

/** Diagnostic for the bound-then-died false positive. Pure (see above). */
export function formatBoundThenDied(
  appId: string, sessionId: string, port: number,
  death: { code: number | null; signal: NodeJS.Signals | null; output: string; portStillBound: boolean },
): string {
  const owner = death.portStillBound
    ? `port ${port} is STILL bound — a process this LAX server does not track owns it (an orphaned dev server from a previous run, or an unrelated app)`
    : `port ${port} is no longer bound`;
  return (
    `lazy restart of dev server "${appId}" (session ${sessionId}) looked listening but the session then exited ` +
    `(${exitDescriptor(death.code, death.signal)}); ${owner}.` +
    (death.output ? `\n--- output (tail) ---\n${death.output}` : "\n(no output captured)")
  );
}

/** Persist a startup-failure diagnostic to server.log (via the logger) AND to a
 *  per-app file, so the cause survives the in-memory session eviction that
 *  previously erased it. Best-effort — never throws into the caller. */
export function persistDevServerStartupFailure(appId: string, diagnostic: string): void {
  logger.warn(`[dev-server] ${diagnostic}`);
  try {
    const p = devServerLogPath(appId);
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, `\n===== ${new Date().toISOString()} =====\n${diagnostic}\n`);
  } catch { /* logging must never break the request path */ }
}

/** Real verifyStartup for the lazy-restart path: poll the re-spawned session;
 *  on a crash or never-bind, persist the diagnostic. A "listening" verdict is
 *  re-checked once after a beat so a foreign port holder can't mask the spawned
 *  child's death (see LISTENING_FLAP_RECHECK_MS). Non-blocking (the caller
 *  voids the promise) so the request that triggered the restart isn't stalled —
 *  this exists purely to CAPTURE why a restart didn't bind. */
export async function verifyDevServerStartup(appId: string, sessionId: string, port: number): Promise<void> {
  const outcome = await waitForBackend(sessionId, port, LAZY_RESTART_VERIFY_MS);
  if (outcome.status !== "listening") {
    persistDevServerStartupFailure(appId, formatStartupFailure(appId, sessionId, port, outcome));
    return;
  }
  await sleep(LISTENING_FLAP_RECHECK_MS);
  const s = SESSIONS.get(sessionId);
  if (s?.exitedAt) {
    persistDevServerStartupFailure(appId, formatBoundThenDied(appId, sessionId, port, {
      code: s.exitCode, signal: s.exitSignal,
      output: tailLines(s.stderr || s.stdout || "", 20).trim(),
      portStillBound: pidsOnPort(port).length > 0,
    }));
    return;
  }
  logger.info(`[dev-server] ${appId}: restart confirmed listening on port ${port}`);
}
