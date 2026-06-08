/**
 * Long-running process tool family.
 *
 * Why: bash is synchronous. Commands that take minutes (ollama pull,
 * npm install, training jobs) either time out or block the entire turn
 * waiting for an empty stdout. The agent has had to escalate to
 * op_submit_async — which spawns a whole subprocess agent driven by an
 * LLM — just to "wait for a command." That's the wrong altitude.
 *
 * process_* gives the model a session abstraction in the SAME process:
 *
 *   process_start({command}) -> {status: running, session_id: x}
 *   process_status({session_id: x, lines?: 50}) -> {ok, exit_code?, running}
 *   process_kill({session_id: x}) -> {ok}
 *   process_list() -> {ok, all sessions}
 *
 * Sessions live in-memory only — a server restart wipes them. Completed
 * sessions are kept for ~5 minutes after exit so the agent can poll one
 * last time, then evicted. Stdout/stderr buffer is capped per session
 * to bound memory.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, basename, resolve, sep } from "node:path";
import type { ToolDefinition, ToolResult } from "../types.js";
import { ok, err, running } from "./result-helpers.js";
import { buildSanitizedEnv } from "./shell-tools.js";
import { evaluateShellCommand } from "../security/shell-policy.js";
import { getSandboxMode } from "../sandbox/index.js";

import { createLogger } from "../logger.js";
const logger = createLogger("tools.process");

interface ProcessSession {
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

const SESSIONS = new Map<string, ProcessSession>();
const MAX_BUFFER_BYTES = 1 * 1024 * 1024;   // per session
const COMPLETED_TTL_MS = 5 * 60_000;        // keep finished sessions 5 min
const MAX_SESSIONS = 32;                     // hard cap, evict oldest finished

function gcSessions(): void {
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
function startSession(
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
function killSession(session: ProcessSession): void {
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

/**
 * Find every PID currently listening on a TCP port, cross-platform and
 * self-contained (the voice-setup pidOnPort is Windows-only and lives in a
 * route module — coupling here would be wrong). Returns integer PIDs; on any
 * failure returns []. Used by process_restart to reclaim a port held by a
 * stale/orphaned process before starting fresh.
 */
function pidsOnPort(port: number): number[] {
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

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

// ── process_start ────────────────────────────────────────────────────────

export const processStartTool: ToolDefinition = {
  name: "process_start",
  description:
    "Start a long-running shell command as a background session. Returns a session_id immediately; the command continues to run. Use process_status to poll for output and exit code, process_kill to terminate. Prefer this over bash for any command that may take more than a few seconds (ollama pull, npm install, training jobs, downloads). Bash is synchronous and will time out or return empty stdout for TTY-only progress.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to run." },
      cwd: { type: "string", description: "Working directory (optional)." },
      env: { type: "object", description: "Extra env vars (optional)." },
    },
    required: ["command"],
  },
  async execute(args): Promise<ToolResult> {
    gcSessions();
    const command = String(args.command || "").trim();
    if (!command) return err("process_start: command is required");

    const cwd = typeof args.cwd === "string" ? args.cwd : undefined;
    const env = args.env as Record<string, string> | undefined;

    const res = startSession(command, cwd, env);
    if ("error" in res) return err(`process_start: spawn failed: ${res.error}`);
    const { session } = res;

    return running(
      session.sessionId,
      `Started session ${session.sessionId}: ${command.slice(0, 80)}${command.length > 80 ? "..." : ""}\nPoll with process_status({session_id: "${session.sessionId}"}). Kill with process_kill.`,
      { command, pid: session.pid },
    );
  },
};

// ── process_status ───────────────────────────────────────────────────────

export const processStatusTool: ToolDefinition = {
  name: "process_status",
  description:
    "Poll a process started via process_start. Returns the latest tail of stdout/stderr plus running/exit_code state. Use lines to control output tail size (default 80, max 500). When status returns running:false, the session is done and exit_code is final.",
  parameters: {
    type: "object",
    properties: {
      session_id: { type: "string", description: "ID returned by process_start." },
      lines: { type: "number", description: "Number of trailing output lines to return (default 80, max 500)." },
    },
    required: ["session_id"],
  },
  async execute(args): Promise<ToolResult> {
    const sessionId = String(args.session_id || "").trim();
    if (!sessionId) return err("process_status: session_id is required");
    const session = SESSIONS.get(sessionId);
    if (!session) {
      return err(`process_status: no such session "${sessionId}". Sessions are evicted ~5 minutes after exit.`);
    }

    const requested = typeof args.lines === "number" ? args.lines : 80;
    const lines = Math.max(1, Math.min(500, Math.floor(requested)));
    const stdoutTail = tailLines(session.stdout, lines);
    const stderrTail = tailLines(session.stderr, lines);
    const isRunning = session.exitedAt === null;
    const durationMs = (session.exitedAt ?? Date.now()) - session.startedAt;

    let body: string;
    if (!stdoutTail && !stderrTail) {
      body = isRunning
        ? `[no captured output yet — ${durationMs}ms elapsed. The command may write progress to TTY only; check filesystem or service API to verify forward motion.]`
        : `[exit ${session.exitCode === null ? "?" : session.exitCode} in ${durationMs}ms — no captured output. If this was a TTY-only progress UI (ollama, winget, npm install), verify success via filesystem or REST API rather than relying on stdout.]`;
    } else {
      body = stdoutTail + (stderrTail ? `\n[stderr]\n${stderrTail}` : "");
    }

    const meta: Record<string, unknown> = {
      running: isRunning,
      duration_ms: durationMs,
      pid: session.pid,
      truncated: session.truncated || undefined,
      total_bytes: session.totalBytes,
    };
    if (!isRunning) meta.exit_code = session.exitCode;

    return ok(body, meta);
  },
};

function tailLines(s: string, n: number): string {
  if (!s) return "";
  const lines = s.split("\n");
  if (lines.length <= n) return s;
  return lines.slice(-n).join("\n");
}

// ── process_kill ─────────────────────────────────────────────────────────

export const processKillTool: ToolDefinition = {
  name: "process_kill",
  description: "Terminate a running process_start session. No-op if the session has already exited.",
  parameters: {
    type: "object",
    properties: {
      session_id: { type: "string" },
    },
    required: ["session_id"],
  },
  async execute(args): Promise<ToolResult> {
    const sessionId = String(args.session_id || "").trim();
    if (!sessionId) return err("process_kill: session_id is required");
    const session = SESSIONS.get(sessionId);
    if (!session) return err(`process_kill: no such session "${sessionId}"`);
    if (session.exitedAt !== null) {
      return ok(`Session ${sessionId} already exited (code=${session.exitCode}).`);
    }
    try {
      const pid = session.child?.pid;
      killSession(session);
      return ok(
        `Killed session ${sessionId} (pid=${pid ?? "?"}).`,
        {
          recovery:
            "Killing the process does not guarantee a network port it held is immediately free. " +
            "To restart a server on the same port, confirm with process_list and use " +
            "process_restart({ command, port }) to reclaim the port cleanly rather than assuming it's free.",
        },
      );
    } catch (e) {
      return err(`process_kill: ${(e as Error).message}`);
    }
  },
};

// ── process_restart ──────────────────────────────────────────────────────

export const processRestartTool: ToolDefinition = {
  name: "process_restart",
  description:
    "Restart: reclaims a port held by a stale/orphaned process, then starts fresh. Use when an edit won't take effect because an old process is still serving. Pass session_id to replace a tracked session (reusing its command/cwd/env unless overridden), and/or port to first SIGTERM/SIGKILL whatever is listening on that port before starting — so the new process won't hit EADDRINUSE. Returns a NEW session_id.",
  parameters: {
    type: "object",
    properties: {
      session_id: { type: "string", description: "Tracked session to replace (optional)." },
      command: { type: "string", description: "Command to start. Required unless session_id is given." },
      port: { type: "number", description: "TCP port to reclaim before starting (optional)." },
      cwd: { type: "string", description: "Working directory (optional)." },
      env: { type: "object", description: "Extra env vars (optional)." },
    },
    required: [],
  },
  async execute(args): Promise<ToolResult> {
    gcSessions();

    let command = typeof args.command === "string" ? args.command.trim() : "";
    let cwd = typeof args.cwd === "string" ? args.cwd : undefined;
    let env = args.env as Record<string, string> | undefined;

    // Replace a tracked session: inherit its command/cwd/env, kill it, wait.
    const oldSessionId = typeof args.session_id === "string" ? args.session_id.trim() : "";
    if (oldSessionId) {
      const old = SESSIONS.get(oldSessionId);
      if (!old) return err(`process_restart: no such session "${oldSessionId}"`);
      if (!command) command = old.command;
      if (cwd === undefined) cwd = old.cwdHint;
      if (env === undefined) env = old.envHint;
      killSession(old);
      const deadline = Date.now() + 3000;
      while (old.exitedAt === null && Date.now() < deadline) await sleep(100);
    }

    if (!command) return err("process_restart: command is required (or pass a session_id to reuse one)");

    // Reclaim the port BEFORE starting so the new process doesn't EADDRINUSE.
    const port = typeof args.port === "number" ? Math.floor(args.port) : undefined;
    if (port !== undefined && port > 0) {
      const holders = pidsOnPort(port);
      for (const pid of holders) {
        try { process.platform === "win32" ? killWinPid(pid) : process.kill(pid, "SIGTERM"); } catch { /* gone */ }
      }
      if (holders.length > 0) await sleep(1000);
      for (const pid of holders) {
        try { process.platform === "win32" ? killWinPid(pid) : process.kill(pid, "SIGKILL"); } catch { /* gone */ }
      }
      const deadline = Date.now() + 5000;
      while (pidsOnPort(port).length > 0 && Date.now() < deadline) await sleep(200);
      if (pidsOnPort(port).length > 0) {
        return err(`process_restart: port ${port} is still held after kill attempt; not starting a doomed process.`);
      }
    }

    const res = startSession(command, cwd, env);
    if ("error" in res) return err(`process_restart: spawn failed: ${res.error}`);
    const { session } = res;

    // Confirm the new process actually grabbed the port.
    let listenCheck = "skipped (no port)";
    let boundPort: boolean | undefined;
    if (port !== undefined && port > 0) {
      boundPort = false;
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        // A grandchild (e.g. node under bash) holds the port, not necessarily
        // session.pid itself — so "non-empty" is the signal we want.
        if (pidsOnPort(port).length > 0) { boundPort = true; break; }
        await sleep(200);
      }
      listenCheck = boundPort ? `listening on ${port}` : `NOT yet listening on ${port} (process may still be starting)`;
    }

    return running(
      session.sessionId,
      `Restarted as session ${session.sessionId}: ${command.slice(0, 80)}${command.length > 80 ? "..." : ""}\nListening check: ${listenCheck}\nPoll with process_status({session_id: "${session.sessionId}"}).`,
      { command, pid: session.pid, bound_port: boundPort },
    );
  },
};

function killWinPid(pid: number): void {
  spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { windowsHide: true, stdio: "ignore" });
}

// ── process_list ─────────────────────────────────────────────────────────

export const processListTool: ToolDefinition = {
  name: "process_list",
  description: "List all known process_start sessions (running and recently exited). Useful for orienting after a restart or when an earlier session_id was lost.",
  parameters: { type: "object", properties: {} },
  async execute(): Promise<ToolResult> {
    gcSessions();
    if (SESSIONS.size === 0) return ok("No active or recent sessions.");
    const lines: string[] = [];
    for (const s of SESSIONS.values()) {
      const dur = (s.exitedAt ?? Date.now()) - s.startedAt;
      const state = s.exitedAt === null ? "running" : `exited(${s.exitCode})`;
      const cmd = s.command.length > 60 ? s.command.slice(0, 60) + "..." : s.command;
      lines.push(`${s.sessionId}  ${state.padEnd(13)}  ${dur}ms  pid=${s.pid ?? "?"}  ${cmd}`);
    }
    return ok(lines.join("\n"), { count: SESSIONS.size });
  },
};

export const processTools: ToolDefinition[] = [
  processStartTool,
  processStatusTool,
  processKillTool,
  processRestartTool,
  processListTool,
];
