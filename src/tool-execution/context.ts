import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { ToolDefinition, ToolResult, ServerEvent } from "../types.js";
import type { SecurityLayer } from "../security/index.js";
import type { ToolPolicy } from "../tool-policy.js";
import type { ThreatEngine } from "../threat/threat-engine.js";
import type { RBACManager, Role } from "../rbac.js";
import { renderToolResultForModel } from "../tools/result-helpers.js";

export type CallContext = "local" | "api" | "delegated" | "cron";

export interface ToolCallContext {
  readonly tc: { id: string; name: string; arguments: string };
  readonly toolMap: Map<string, ToolDefinition>;
  readonly security: SecurityLayer;
  readonly toolPolicy?: ToolPolicy;
  readonly threatEngine?: ThreatEngine;
  readonly rbac?: RBACManager;
  readonly callerRole?: Role;
  readonly sessionId?: string;
  /** Stable run id when this tool call is part of an agent run (canonical-loop
   *  agent-runner threads its agentId/runId through here). Absent for chat
   *  turns, MCP bridge calls, and other ad-hoc dispatches — the trace
   *  emit-phase short-circuits when absent. */
  readonly runId?: string;
  readonly onEvent?: (event: ServerEvent) => void;
  readonly signal?: AbortSignal;
  readonly priorMessages?: ChatCompletionMessageParam[];

  callContext: CallContext;
  args: Record<string, unknown>;
  tool?: ToolDefinition;
  riskLevel: "low" | "medium" | "high";
  approvalContext: string;

  startedAt?: number;
  result?: ToolResult;

  allowed: boolean;
  msgs: ChatCompletionMessageParam[];
}

// A phase's control-flow signal to the orchestrator, replacing the old
// hidden `ctx.terminated` / `ctx.preBlocked` flags read between phase calls.
//   continue — chain proceeds to the next phase.
//   halt     — phase produced the final tool message (via `terminate`) and
//              the chain stops. The orchestrator decides whether a trailing
//              audit runs (it does only for the dedup-hit position).
//   block    — pre-dispatch chain (security/RBAC/tool-policy) or unknown-tool
//              fired: `ctx.result` is set but no message was pushed. Skips
//              approval + execute; audit still runs so the threat engine +
//              hooks see the block and render its message.
export type PhaseOutcome =
  | { kind: "continue" }
  | { kind: "halt" }
  | { kind: "block" };

export const CONTINUE: PhaseOutcome = { kind: "continue" };
export const HALT: PhaseOutcome = { kind: "halt" };
export const BLOCK: PhaseOutcome = { kind: "block" };

export type Phase = (ctx: ToolCallContext) => Promise<PhaseOutcome>;

export function createContext(input: {
  tc: { id: string; name: string; arguments: string };
  toolMap: Map<string, ToolDefinition>;
  security: SecurityLayer;
  toolPolicy?: ToolPolicy;
  threatEngine?: ThreatEngine;
  rbac?: RBACManager;
  callerRole?: Role;
  sessionId?: string;
  runId?: string;
  onEvent?: (event: ServerEvent) => void;
  signal?: AbortSignal;
  priorMessages?: ChatCompletionMessageParam[];
}): ToolCallContext {
  return {
    tc: input.tc,
    toolMap: input.toolMap,
    security: input.security,
    toolPolicy: input.toolPolicy,
    threatEngine: input.threatEngine,
    rbac: input.rbac,
    callerRole: input.callerRole,
    sessionId: input.sessionId,
    runId: input.runId,
    onEvent: input.onEvent,
    signal: input.signal,
    priorMessages: input.priorMessages,
    callContext: "local",
    args: {},
    riskLevel: "low",
    approvalContext: "",
    allowed: true,
    msgs: [],
  };
}

// Build the final tool msg, emit tool_end, and return the halt outcome so the
// calling phase short-circuits the chain. `rendered: "raw"` writes content
// verbatim (used by paths that build a human-readable string directly).
// `rendered: "model"` runs the content through renderToolResultForModel for
// ToolResult-shaped values.
export function terminate(
  ctx: ToolCallContext,
  payload:
    | { rendered: "raw"; content: string; allowed: boolean }
    | { rendered: "model"; result: ToolResult; allowed: boolean },
): PhaseOutcome {
  if (payload.rendered === "raw") {
    ctx.allowed = payload.allowed;
    ctx.onEvent?.({ type: "tool_end", toolName: ctx.tc.name, toolCallId: ctx.tc.id, result: payload.content, allowed: payload.allowed });
    ctx.msgs.push({ role: "tool", tool_call_id: ctx.tc.id, content: payload.content } as ChatCompletionMessageParam);
  } else {
    ctx.allowed = payload.allowed;
    ctx.result = payload.result;
    ctx.onEvent?.({ type: "tool_end", toolName: ctx.tc.name, toolCallId: ctx.tc.id, result: payload.result.content, allowed: payload.allowed });
    ctx.msgs.push({ role: "tool", tool_call_id: ctx.tc.id, content: renderToolResultForModel(payload.result) } as ChatCompletionMessageParam);
  }
  return HALT;
}
