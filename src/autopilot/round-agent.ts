/**
 * Spawn one round of an autopilot operation.
 *
 * Routes through canonical-loop's `runAgentViaCanonical` so the round shares
 * the same safety stack, observability, and cancel machinery as chat. The
 * session is bound to the autopilot worktree via security.addAllowedPath.
 */

import { type AgentOptions } from "../providers/types.js";
import { runAgentViaCanonical } from "../canonical-loop/agent-runner.js";
import type { Operation, OperationPhase } from "../operations/types.js";
import type { AutopilotConfig } from "./types.js";
import type { ToolDefinition, LAXConfig } from "../types.js";
import { SecurityLayer } from "../security.js";
import { extractAgentOutput } from "../server-utils.js";
import { registerAutopilotSession, unregisterAutopilotSession, getSelfEditCount } from "./registry.js";
import { buildAutopilotNudge, type NudgeContext } from "./nudge.js";

import { createLogger } from "../logger.js";
const logger = createLogger("autopilot.round-agent");

export interface RoundAgentDeps {
  config: LAXConfig;
  apiKey: string;
  model: string;
  provider: AgentOptions["provider"];
  /** Tools the chat session normally has — we filter to autopilot-safe subset. */
  allTools: ToolDefinition[];
}

export interface RoundAgentOptions {
  opId: string;
  autopilot: AutopilotConfig;
  round: number;
  timeRemainingMs: number;
  roundsCompleted: number;
  selfEditUsed: number;
  lastRound?: NudgeContext["lastRound"];
  /** Per-round wall-clock ceiling. Threaded into canonical's per-op
   *  wallClockMs so the cancel routes through canonical's state machine. */
  wallClockMs?: number;
}

export interface RoundAgentResult {
  /** Full agent text output. */
  output: string;
  /** True if the agent emitted "AUTOPILOT_DONE: ..." in its final reply. */
  autopilotDone: boolean;
  /** Reason text after AUTOPILOT_DONE:, if present. */
  doneReason: string | null;
  /** stop reason from the underlying runAgent call. */
  stopReason: string;
  /** how many self_edit calls this round actually consumed. */
  selfEditCallsThisRound: number;
  /** Wall-clock ms. */
  durationMs: number;
}

const AUTOPILOT_DONE_RE = /^\s*AUTOPILOT_DONE:\s*(.+?)\s*$/m;

/** Tools the round agent gets. Mission scheduling is filtered out (no recursive scheduling). */
function filterAutopilotTools(allTools: ToolDefinition[]): ToolDefinition[] {
  return allTools.filter(t => !t.name.startsWith("mission_schedule_"));
}

export async function runAutopilotRound(
  deps: RoundAgentDeps,
  opts: RoundAgentOptions,
): Promise<RoundAgentResult> {
  const sessionId = `autopilot-${opts.opId}-r${opts.round}`;
  const start = Date.now();

  // Scope security to the worktree only. Same pattern as handler-events.ts:120.
  // file-access mode "common" + the explicit allowed path means agent can read
  // common locations (incl. main repo) but writes are limited to the worktree.
  const security = new SecurityLayer(opts.autopilot.worktreePath, "common");
  security.addAllowedPath(opts.autopilot.worktreePath, sessionId);

  registerAutopilotSession(sessionId, opts.opId, opts.autopilot.worktreePath, opts.autopilot.maxSelfEditCalls);

  try {
    const tools = filterAutopilotTools(deps.allTools);

    const systemPrompt = buildAutopilotNudge({
      config: opts.autopilot,
      round: opts.round,
      timeRemainingMs: opts.timeRemainingMs,
      roundsCompleted: opts.roundsCompleted,
      selfEditUsed: opts.selfEditUsed,
      lastRound: opts.lastRound,
    });

    // Round agent's "user message" is just a kick — the system prompt has
    // everything it needs. Keep it short to avoid token bloat.
    const userMessage = `Begin round ${opts.round}.`;

    const result = await runAgentViaCanonical(userMessage, [], {
      apiKey: deps.apiKey,
      model: deps.model,
      provider: deps.provider,
      systemPrompt,
      tools,
      security,
      sessionId,
      maxIterations: deps.config.maxIterations,
      wallClockMs: opts.wallClockMs,
      opType: "autopilot_round",
      lane: "background",
      // Live sidebar progress: forward each tool call as a bg_op_progress
      // line tagged with this autopilot's opId. Without this the sidebar
      // card sits silent for whole rounds (5-10 min) — looks like the
      // agent died. With it, the user can watch the agent work in real time.
      onEvent: async (event) => {
        if (event.type !== "tool_start") return;
        const tn = (event as { toolName?: string }).toolName || "tool";
        const args = (event as { arguments?: unknown; args?: unknown }).arguments
                  || (event as { arguments?: unknown; args?: unknown }).args;
        let detail = "";
        if (typeof args === "string") {
          try {
            const parsed = JSON.parse(args) as Record<string, unknown>;
            const path = parsed.path || parsed.file_path;
            const cmd = parsed.command || parsed.cmd;
            const url = parsed.url;
            const pattern = parsed.pattern || parsed.query;
            const task = parsed.task || parsed.description;
            const pick = (path || cmd || url || pattern || task);
            if (typeof pick === "string") {
              // Strip the project-folder prefix from displayed paths. Use
              // process.cwd() so this tracks any folder rename — earlier
              // hardcoded `secret-agent-x` slug was brittle.
              const cwd = process.cwd().replace(/[/\\]+$/, "");
              const escaped = cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
              const cleaned = pick.replace(new RegExp(`^${escaped}[/\\\\]`, "i"), "");
              detail = cleaned.length > 80 ? cleaned.slice(0, 79) + "…" : cleaned;
            }
          } catch { /* args wasn't JSON — fall through with no detail */ }
        }
        try {
          const { broadcastAll } = await import("../chat-ws.js");
          // Wrap in the worker pool's broadcast envelope so chat.js's
          // msg.event.type === 'bg_op_progress' check actually fires.
          broadcastAll({
            type: "event",
            sessionId: "autopilot",
            event: {
              type: "bg_op_progress",
              opId: opts.opId,
              line: detail ? `→ ${tn} ${detail}` : `→ ${tn}`,
            },
          });
        } catch { /* swallow — broadcast is best-effort */ }
      },
    });

    const output = extractAgentOutput(result.messages) || "";
    const doneMatch = output.match(AUTOPILOT_DONE_RE);
    const autopilotDone = !!doneMatch;
    const doneReason = doneMatch ? doneMatch[1].trim() : null;

    logger.info(`[autopilot] round ${opts.round} finished: stopReason=${result.stopReason}, autopilotDone=${autopilotDone}, ${output.length} chars`);

    return {
      output,
      autopilotDone,
      doneReason,
      stopReason: result.stopReason,
      selfEditCallsThisRound: getSelfEditCount(sessionId),
      durationMs: Date.now() - start,
    };
  } finally {
    unregisterAutopilotSession(sessionId);
    security.removeAllowedPath(opts.autopilot.worktreePath, sessionId);
  }
}

/** Hint to the autopilot loop when it sees the marker. Keep this in sync with the regex. */
export const AUTOPILOT_DONE_MARKER = "AUTOPILOT_DONE:";

// Silence unused-import lints for types referenced only in TypeScript type position.
type _UnusedRefs = Operation | OperationPhase;
void (null as unknown as _UnusedRefs);
