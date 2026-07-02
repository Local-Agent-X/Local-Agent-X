/**
 * Shared dev-server readiness probe.
 *
 * ONE implementation of "did the spawned dev server actually bind its port, or
 * did it crash?" used by BOTH entry points so they can't drift:
 *   - the agent-facing app_serve_* tools (dev-server-tools.ts), which block on
 *     it before claiming a backend is ready, and
 *   - the lazy restart in ensureDevServerRunning (dev-server.ts), which fires it
 *     non-blocking to CAPTURE the failure (the idle-sweep-then-reopen path that
 *     previously logged "(re)started" and then silently 502'd, with the child's
 *     stderr lost to session eviction).
 *
 * Leaf module (imports only process-session) so both callers can import it
 * without a cycle.
 */
import { SESSIONS, sleep, tailLines, pidsOnPort } from "./process-session.js";

export type BackendOutcome =
  | { status: "listening" }
  | { status: "crashed"; code: number | null; output: string }
  | { status: "timeout"; output: string };

const BACKEND_POLL_MS = 400;

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
      return { status: "crashed", code: s.exitCode, output: tailLines(s.stderr || s.stdout || "", 20).trim() };
    }
    if (pidsOnPort(port).length > 0) return { status: "listening" };
  }
  return { status: "timeout", output: sessionOutput(sessionId) };
}
