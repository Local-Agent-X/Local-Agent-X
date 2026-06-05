// Spawn one long-lived `claude -p --input-format=stream-json` process and
// wire stdout/stderr/exit handlers. The pool calls this when it needs a
// fresh process; the per-turn driver (stream-prompt) only reads from the
// already-spawned process via its activeListener.
//
// Sandbox boundary: only this file imports child_process for the warm pool.
// stream-prompt.ts writes to stdin via the WarmProcess handle but never
// spawns.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { unlinkSync } from "node:fs";
import { npmAugmentedEnv } from "../cli-path.js";
import { writeMcpConfig } from "../mcp-config.js";
import { createLogger } from "../../logger.js";
import type { WarmPoolKey, WarmProcess } from "./types.js";
import { keyStr } from "./types.js";

const logger = createLogger("anthropic-client.warm-pool.spawn");

// Block ALL Claude Code native tools regardless of MCP/text-only mode.
// Without this, plan mode still leaks the model into emitting Read/Bash/
// Glob/Grep/AskUserQuestion calls — the user sees the agent "exploring"
// their filesystem on a "hi". Local Agent X's own tools are surfaced via
// MCP (when MCP is wired below); the native set is always off.
const DISALLOWED_TOOLS = [
  "Bash", "Read", "Write", "Edit", "Glob", "Grep",
  "WebFetch", "WebSearch", "TodoWrite", "ToolSearch",
  "NotebookEdit", "Task", "AskUserQuestion", "Skill",
  "CronCreate", "CronDelete", "CronList",
  "EnterPlanMode", "ExitPlanMode",
  "EnterWorktree", "ExitWorktree",
  "Monitor", "TaskOutput", "TaskStop",
  "ScheduleWakeup", "PushNotification", "RemoteTrigger",
].join(",");

export interface SpawnCallbacks {
  /** Called when this process exits; pool uses it to wake waiters and
   *  drop the dead process from the pool. */
  onExit: (keyStr: string) => void;
}

export function spawnWarmProcess(key: WarmPoolKey, callbacks: SpawnCallbacks): WarmProcess {
  const args = [
    "-p",
    "--model", key.model,
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--replay-user-messages",
    "--no-session-persistence",
    "--permission-mode", key.permissionMode,
    "--verbose",
    "--disallowed-tools", DISALLOWED_TOOLS,
  ];

  // MCP bridge wiring: required when this pool entry is bound to a chat
  // session. The bridge subprocess is spawned by the CLI itself and stays
  // alive for the lifetime of the warm process — no per-turn bridge cold
  // start. This is the bigger win for tool-using turns (saves ~600ms per
  // turn, compounds across the session).
  let mcpConfigPath: string | null = null;
  if (key.sessionId && key.laxPort && key.laxToken) {
    try {
      mcpConfigPath = writeMcpConfig({
        port: key.laxPort,
        token: key.laxToken,
        sessionId: key.sessionId,
        tag: `warmpool-${key.sessionId}`,
      });
      args.push("--mcp-config", mcpConfigPath);
    } catch (e) {
      logger.warn(`[warm-pool] MCP config setup failed for sess=${key.sessionId}: ${(e as Error).message}`);
      mcpConfigPath = null;
    }
  }

  const proc = spawn("claude", args, {
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
    env: npmAugmentedEnv(),
  }) as ChildProcessWithoutNullStreams;

  const wp: WarmProcess = {
    proc,
    key: keyStr(key),
    state: "idle",
    lastUsedAt: Date.now(),
    spawnedAt: Date.now(),
    activeListener: null,
    buffer: "",
    stderr: "",
    mcpConfigPath,
  };

  proc.stderr?.on("data", (chunk: Buffer) => {
    wp.stderr += chunk.toString();
    if (wp.stderr.length > 4096) wp.stderr = wp.stderr.slice(-2048);
  });

  proc.stdout?.on("data", (chunk: Buffer) => {
    wp.buffer += chunk.toString();
    const lines = wp.buffer.split("\n");
    wp.buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let frame: unknown;
      try { frame = JSON.parse(line); } catch { continue; }
      if (wp.activeListener) wp.activeListener(frame);
    }
  });

  proc.on("exit", (code) => {
    wp.state = "dead";
    if (wp.mcpConfigPath) {
      try { unlinkSync(wp.mcpConfigPath); } catch { /* already gone */ }
    }
    logger.info(`[warm-pool] process exited code=${code} key=${wp.key} age=${Math.round((Date.now() - wp.spawnedAt) / 1000)}s stderr_tail=${wp.stderr.slice(-200)}`);
    callbacks.onExit(wp.key);
  });

  proc.on("error", (e) => {
    logger.warn(`[warm-pool] spawn error key=${wp.key}: ${e.message}`);
    wp.state = "dead";
  });

  logger.info(`[warm-pool] spawned new process key=${wp.key}`);
  return wp;
}
