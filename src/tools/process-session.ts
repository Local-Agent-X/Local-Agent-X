/**
 * Long-running process session registry + bookkeeping.
 *
 * The in-memory session map and the helpers that spawn, kill, garbage-collect,
 * and inspect sessions. The process_* tool definitions (process-tools-defs.ts)
 * are thin wrappers over these helpers — this module owns all the state.
 *
 * Sessions live in-memory only — a server restart wipes them. Completed
 * sessions are kept for ~5 minutes after exit so the agent can poll one
 * last time, then evicted. Stdout/stderr buffer is capped per session
 * to bound memory.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, basename, resolve, sep } from "node:path";
import { buildSanitizedEnv } from "./shell-tools.js";
import { evaluateShellCommand } from "../security/shell-policy.js";
import { getSandboxMode } from "../sandbox/index.js";

import { createLogger } from "../logger.js";
const logger = createLogger("tools.process");

export interface ProcessSession {
  sessionId: string;
  command: string;
  /** cwd/env the session was started with, so process_restart can reuse them. */
  cwdHint?: string;
  envHint?: Record<string, string>;
  pid: number | null;
  child: ChildProcess | null;
  startedAt: number;
  exitedAt: number | null;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  /** Bytes read past the per-session cap. Reported in metadata so the
   *  model knows output is being clipped. */
  totalBytes: number;
}

export const SESSIONS = new Map<string, ProcessSession>();
const MAX_BUFFER_BYTES = 1 * 1024 * 1024;   // per session
const COMPLETED_TTL_MS = 5 * 60_000;        // keep finished sessions 5 min
const MAX_SESSIONS = 32;                     // hard cap, evict oldest finished

export function gcSessions(): void {
  const now = Date.now();
  let finishedCount = 0;
  for (const s of SESSIONS.values()) if (s.exitedAt !== null) finishedCount++;

  // TTL eviction
  for (const [id, s] of SESSIONS) {
    if (s.exitedAt !== null && now - s.exitedAt > COMPLETED_TTL_MS) {
      SESSIONS.delete(id);
    }
  }

  // Hard cap — drop oldest finished if we're still over.
  if (SESSIONS.size > MAX_SESSIONS) {
    const finished = [...SESSIONS.values()]
      .filter(s => s.exitedAt !== null)
      .sort((a, b) => (a.exitedAt || 0) - (b.exitedAt || 0));
    while (SESSIONS.size > MAX_SESSIONS && finished.length > 0) {
      const victim = finished.shift();
      if (victim) SESSIONS.delete(victim.sessionId);
    }
  }
  void finishedCount; // suppress unused warning if logging is added later
}

function newSessionId(): string {
  return `px-${randomBytes(4).toString("hex")}`;
}

// Credential scrub: process_* spawn a shell exactly like bash, so they must
// scrub the same way. Delegates to the shared bash env-scrub (credential-name
// + high-entropy-value allowlist) instead of copying the full process.env,
// which leaked sidecar secrets to every background command.
function sanitizeEnv(extra?: Record<string, string>): Record<string, string> {
  return buildSanitizedEnv(extra);
}

/**
 * Build a session, spawn the command in a detached process group (so a
 * later `process.kill(-pid)` tree-kills any grandchild like a node server),
 * and wire up stdout/stderr/exit capture. Shared by process_start and
 * process_restart so there's exactly one spawn path. Returns the live
 * session, or an error string if spawn threw synchronously.
 */
export function startSession(
  command: string,
  cwd?: string,
  env?: Record<string, string>,
): { session: ProcessSession } | { error: string } {
  // Same command vetting bash gets: denylist + metachar/obfuscation scan.
  // process_start spawns through /bin/bash -c (or powershell -Command), so an
  // unvetted command here is identical RCE to an unvetted bash call.
  const verdict = evaluateShellCommand(command);
  if (!verdict.allowed) {
    return { error: `blocked by shell policy: ${verdict.reason}` };
  }

  // Honor sandbox mode. process_* keeps a live ChildProcess handle for
  // polling/kill, which the synchronous docker exec path (execInSandbox)
  // can't provide — so rather than silently host-spawning and defeating the
  // sandbox, refuse and point the caller at bash (which has a real docker
  // path) or at disabling the sandbox.
  if (getSandboxMode() === "docker") {
    return {
      error:
        "Sandbox mode is docker — process_start cannot run a tracked background session inside the container. " +
        "Use bash for one-shot commands (it routes through the sandbox), or set LAX_SANDBOX=host / toggle Sandbox off in Settings to allow host background processes.",
    };
  }

  const sessionId = newSessionId();
  const isWin = process.platform === "win32";
  const shell = isWin ? "powershell.exe" : "/bin/bash";
  const shellArgs = isWin ? ["-NoProfile", "-Command", command] : ["-c", command];

  let child: ChildProcess;
  try {
    // detached:true on non-Windows makes the child a process-group leader so
    // process_kill's `process.kill(-pid, "SIGKILL")` reaches grandchildren
    // (e.g. a node server holding a port). On Windows taskkill /T handles the
    // tree, and detached would risk a stray console. Pipes are unaffected.
    child = spawn(shell, shellArgs, {
      env: sanitizeEnv(env),
      cwd,
      windowsHide: true,
      detached: !isWin,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.unref();
  } catch (e) {
    return { error: (e as Error).message };
  }

  const session: ProcessSession = {
    sessionId,
    command,
    cwdHint: cwd,
    envHint: env,
    pid: child.pid ?? null,
    child,
    startedAt: Date.now(),
    exitedAt: null,
    exitCode: null,
    stdout: "",
    stderr: "",
    truncated: false,
    totalBytes: 0,
  };
  SESSIONS.set(sessionId, session);

  child.stdout?.setEncoding("utf-8");
  child.stderr?.setEncoding("utf-8");
  child.stdout?.on("data", (chunk: string) => {
    session.totalBytes += chunk.length;
    if (session.stdout.length + chunk.length <= MAX_BUFFER_BYTES) {
      session.stdout += chunk;
    } else {
      session.truncated = true;
      const room = MAX_BUFFER_BYTES - session.stdout.length;
      if (room > 0) session.stdout += chunk.slice(0, room);
    }
  });
  child.stderr?.on("data", (chunk: string) => {
    session.totalBytes += chunk.length;
    if (session.stderr.length + chunk.length <= MAX_BUFFER_BYTES) {
      session.stderr += chunk;
    } else {
      session.truncated = true;
      const room = MAX_BUFFER_BYTES - session.stderr.length;
      if (room > 0) session.stderr += chunk.slice(0, room);
    }
  });
  child.on("error", (e) => {
    logger.warn(`session ${sessionId} spawn error: ${e.message}`);
    session.exitCode = -1;
    session.exitedAt = Date.now();
    session.stderr += `\n[spawn error] ${e.message}`;
  });
  child.on("exit", (code) => {
    session.exitCode = code;
    session.exitedAt = Date.now();
    session.child = null;
  });

  return { session };
}

/**
 * Tree-kill a running session. Mirrors processKillTool's logic: negative-pid
 * group kill on POSIX (works because startSession spawns detached), taskkill
 * /T on Windows. No-op if already exited.
 */
export function killSession(session: ProcessSession): void {
  if (session.exitedAt !== null) return;
  const pid = session.child?.pid;
  if (process.platform === "win32" && pid) {
    spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { windowsHide: true, stdio: "ignore" });
  } else if (pid) {
    try { process.kill(-pid, "SIGKILL"); } catch { session.child?.kill("SIGKILL"); }
  } else {
    session.child?.kill("SIGKILL");
  }
}

export function killWinPid(pid: number): void {
  spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { windowsHide: true, stdio: "ignore" });
}

/**
 * Find every PID currently listening on a TCP port, cross-platform and
 * self-contained (the voice-setup pidOnPort is Windows-only and lives in a
 * route module — coupling here would be wrong). Returns integer PIDs; on any
 * failure returns []. Used by process_restart to reclaim a port held by a
 * stale/orphaned process before starting fresh.
 */
export function pidsOnPort(port: number): number[] {
  if (!Number.isInteger(port) || port <= 0) return [];
  const isWin = process.platform === "win32";
  try {
    let out: string;
    if (isWin) {
      out = execFileSync("powershell.exe", [
        "-NoProfile", "-Command",
        `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess)`,
      ], { encoding: "utf-8", timeout: 5000, windowsHide: true });
    } else {
      out = execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf-8", timeout: 5000 });
    }
    const pids = new Set<number>();
    for (const line of out.split(/\r?\n/)) {
      const n = Number(line.trim());
      if (Number.isInteger(n) && n > 0) pids.add(n);
    }
    return [...pids];
  } catch {
    return [];
  }
}

/**
 * Best-effort: which live sessions plausibly serve `absPath` (so a write/edit
 * can warn that the running process still serves the OLD code until restarted).
 * Conservative + side-effect free — only non-exited sessions, heuristic match:
 * the session's cwdHint is an ancestor of absPath, OR the command string
 * mentions the file's directory or basename. False negatives are fine (a missed
 * note); we avoid false positives by not matching on partial substrings.
 */
export function runningSessionsForPath(absPath: string): { sessionId: string; command: string }[] {
  const target = resolve(absPath);
  const targetDir = dirname(target);
  const base = basename(target);
  const out: { sessionId: string; command: string }[] = [];
  for (const s of SESSIONS.values()) {
    if (s.exitedAt !== null) continue;
    let match = false;
    if (s.cwdHint) {
      const cwd = resolve(s.cwdHint);
      // Ancestor check: target is inside cwd (or equals it). Append sep so
      // "/srv/app" doesn't match "/srv/application".
      if (target === cwd || target.startsWith(cwd + sep)) match = true;
    }
    if (!match && (s.command.includes(targetDir) || s.command.includes(base))) match = true;
    if (match) out.push({ sessionId: s.sessionId, command: s.command });
  }
  return out;
}

export function tailLines(s: string, n: number): string {
  if (!s) return "";
  const lines = s.split("\n");
  if (lines.length <= n) return s;
  return lines.slice(-n).join("\n");
}

export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
