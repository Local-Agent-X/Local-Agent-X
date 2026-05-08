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
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { ToolDefinition, ToolResult } from "../types.js";
import { ok, err, running } from "./result-helpers.js";

import { createLogger } from "../logger.js";
const logger = createLogger("tools.process");

interface ProcessSession {
  sessionId: string;
  command: string;
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

function sanitizeEnv(extra?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!v) continue;
    if (v.includes("\0")) continue;
    out[k] = v;
  }
  if (extra) for (const [k, v] of Object.entries(extra)) {
    if (typeof v === "string" && !v.includes("\0")) out[k] = v;
  }
  return out;
}

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

    const sessionId = newSessionId();
    const cwd = typeof args.cwd === "string" ? args.cwd : undefined;
    const env = sanitizeEnv(args.env as Record<string, string> | undefined);

    const isWin = process.platform === "win32";
    const shell = isWin ? "powershell.exe" : "/bin/bash";
    const shellArgs = isWin ? ["-NoProfile", "-Command", command] : ["-c", command];

    let child: ChildProcess;
    try {
      child = spawn(shell, shellArgs, { env, cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return err(`process_start: spawn failed: ${(e as Error).message}`);
    }

    const session: ProcessSession = {
      sessionId,
      command,
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

    return running(
      sessionId,
      `Started session ${sessionId}: ${command.slice(0, 80)}${command.length > 80 ? "..." : ""}\nPoll with process_status({session_id: "${sessionId}"}). Kill with process_kill.`,
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
      if (process.platform === "win32" && pid) {
        spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { windowsHide: true, stdio: "ignore" });
      } else if (pid) {
        try { process.kill(-pid, "SIGKILL"); } catch { session.child?.kill("SIGKILL"); }
      } else {
        session.child?.kill("SIGKILL");
      }
      return ok(`Killed session ${sessionId} (pid=${pid ?? "?"}).`);
    } catch (e) {
      return err(`process_kill: ${(e as Error).message}`);
    }
  },
};

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
  processListTool,
];
