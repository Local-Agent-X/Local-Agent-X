/**
 * Autopilot tools for the chat agent.
 *
 * These let the chat agent launch an autopilot session by name
 * without going through the HTTP API. The tool execute functions need
 * runtime context that's not in the ToolDefinition signature, so they
 * read from a globally-injected context that the server sets at startup.
 */

import type { ToolDefinition } from "../types.js";
import type { LAXConfig } from "../types.js";
import type { AgentOptions } from "../providers/types.js";
import { startAutopilot } from "./start.js";
import { requestStop, getActiveAutopilotOp, listActiveAutopilotOps } from "./loop.js";
import { readLock } from "./lock.js";

interface AutopilotToolsContext {
  config: LAXConfig;
  apiKey: string;
  model: string;
  provider: AgentOptions["provider"];
  allTools: ToolDefinition[];
  workspaceDir: string;
}

type ContextResolver = () => Promise<AutopilotToolsContext | null>;
let resolveContext: ContextResolver | null = null;

/**
 * Server bootstrap calls this with an async resolver so the tools can fetch
 * the latest provider/key/model on each invocation (auth can change at runtime).
 */
export function setAutopilotToolsContext(resolver: ContextResolver): void {
  resolveContext = resolver;
}

async function getCtx(): Promise<AutopilotToolsContext | null> {
  return resolveContext ? resolveContext() : null;
}

export const autopilotStartTool: ToolDefinition = {
  name: "autopilot_start",
  compactDescription: "Autonomous session that edits Local Agent X's OWN source in a git worktree. Only when the user asks to change Local Agent X itself, never for their own projects or websites. Requires developer_mode.",
  description:
    "Launch AUTOPILOT MODE on Local Agent X's OWN source code: an agent edits and builds this app's engine autonomously inside an isolated git worktree of the Local Agent X repo, one commit per round, until it self-terminates, time runs out, or you interrupt. " +
    "Use ONLY when the user explicitly asks for an autonomous session that changes Local Agent X itself (e.g. 'autopilot: fix Local Agent X's cron edge cases'). " +
    "It reaches nothing outside that repo, so it is NOT for the user's own projects, websites, apps or files; handle those with the normal tools, even when the user names a time budget. " +
    "REQUIRES the developer_mode setting (off by default, user-owned); with it off the call is refused.",
  parameters: {
    type: "object",
    properties: {
      topic: { type: "string", description: "What the agent should change in Local Agent X (e.g., 'fix cron edge cases')" },
      scope: { type: "array", items: { type: "string" }, description: "Paths or globs in the Local Agent X repo the agent should focus on, e.g. 'src/cron/' (HINT, not enforcement). Required." },
      durationMs: { type: "number", description: "Time budget in ms. Default 1800000 (30 min)." },
      maxRounds: { type: "number", description: "Max rounds before stop. Default 20." },
      maxNoopRounds: { type: "number", description: "Stop after this many no-op rounds in a row. Default 2." },
      maxSelfEditCalls: { type: "number", description: "Per-shift self_edit invocation cap. Default 5." },
      withTests: { type: "boolean", description: "Also run tests as a validation gate (slower). Default false." },
    },
    required: ["topic", "scope"],
  },
  async execute(args) {
    const ctx = await getCtx();
    if (!ctx) return { content: "Autopilot tool context not initialized — server bootstrap incomplete.", isError: true };
    const result = await startAutopilot({
      topic: String(args.topic || ""),
      scope: Array.isArray(args.scope) ? args.scope.map(String) : [],
      durationMs: typeof args.durationMs === "number" ? args.durationMs : undefined,
      maxRounds: typeof args.maxRounds === "number" ? args.maxRounds : undefined,
      maxNoopRounds: typeof args.maxNoopRounds === "number" ? args.maxNoopRounds : undefined,
      maxSelfEditCalls: typeof args.maxSelfEditCalls === "number" ? args.maxSelfEditCalls : undefined,
      withTests: typeof args.withTests === "boolean" ? args.withTests : undefined,
    }, ctx);
    if (!result.ok) {
      return { content: `Autopilot start failed: ${result.reason}`, isError: true };
    }
    const minutes = Math.round(result.config.durationMs / 60_000);
    return {
      content: `Autopilot launched.\n  op: ${result.opId}\n  branch: ${result.branchName}\n  worktree: ${result.worktreePath}\n  duration: ${minutes}m\n  scope hint: ${result.config.scope.join(", ")}\n\nPoll status with autopilot_status({opId}). Stop with autopilot_stop({opId}).`,
    };
  },
};

export const autopilotStopTool: ToolDefinition = {
  name: "autopilot_stop",
  description: "Request stop on an active autopilot session. Current round finishes, then the loop exits. Use when the user wants to interrupt — they can still review and merge whatever rounds shipped.",
  parameters: {
    type: "object",
    properties: { opId: { type: "string", description: "The autopilot op ID returned by autopilot_start." } },
    required: ["opId"],
  },
  async execute(args) {
    const opId = String(args.opId || "");
    if (!opId) return { content: "opId is required.", isError: true };
    const op = getActiveAutopilotOp(opId);
    if (!op) return { content: `No active autopilot op ${opId} — already finished or never started.`, isError: true };
    const newlyRequested = requestStop(opId);
    return {
      content: newlyRequested
        ? `Stop requested for op ${opId}. Current round will finish, then the loop will exit.`
        : `Stop already requested for op ${opId} — waiting for current round to finish.`,
    };
  },
};

export const autopilotStatusTool: ToolDefinition = {
  name: "autopilot_status",
  description: "Inspect autopilot state. Without opId, lists all active autopilots in this repo. With opId, returns full state including per-round results.",
  parameters: {
    type: "object",
    properties: { opId: { type: "string", description: "Optional — specific op ID. Omit to list all active." } },
  },
  async execute(args) {
    const opId = typeof args.opId === "string" ? args.opId : null;
    if (!opId) {
      const ops = listActiveAutopilotOps();
      const lock = readLock();
      if (ops.length === 0) {
        return { content: lock ? `No active autopilot ops. Lock held by: pid=${lock.pid}, op=${lock.opId}` : `No active autopilot ops. No lock held.` };
      }
      const lines = ops.map(op => `  - ${op.id}: "${op.autopilot?.topic}" — ${(op.autopilotRounds || []).length} rounds, ${op.status}, branch ${op.autopilot?.branchName}`);
      return { content: `Active autopilot ops (${ops.length}):\n${lines.join("\n")}` };
    }
    const op = getActiveAutopilotOp(opId);
    if (!op) return { content: `op ${opId} not active. (May be already complete; check workspace/operations/${opId}/summary.md)` };
    const rounds = op.autopilotRounds || [];
    const lastEvents = op.events.slice(-5).map(e => `    [${e.level}] ${e.message.slice(0, 120)}`).join("\n");
    return {
      content:
        `op ${opId}\n` +
        `  topic: ${op.autopilot?.topic}\n` +
        `  branch: ${op.autopilot?.branchName}\n` +
        `  status: ${op.status}\n` +
        `  rounds: ${rounds.length} (passed: ${rounds.filter(r => r.outcome === "passed").length}, failed: ${rounds.filter(r => r.outcome.startsWith("failed-")).length}, noop: ${rounds.filter(r => r.outcome === "noop").length})\n` +
        `  last events:\n${lastEvents}`,
    };
  },
};

export const autopilotTools: ToolDefinition[] = [autopilotStartTool, autopilotStopTool, autopilotStatusTool];
