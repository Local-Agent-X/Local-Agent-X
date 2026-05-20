import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { ToolDefinition, ToolResult, ServerEvent } from "../types.js";
import type { SecurityLayer } from "../security.js";
import type { ToolPolicy } from "../tool-policy.js";
import type { ThreatEngine } from "../threat-engine.js";
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

  // preBlocked: pre-dispatch chain (security/RBAC/tool-policy) or
  // unknown-tool fired. Skips approval + execute, still runs audit so
  // threat engine + hooks see the block message.
  preBlocked: boolean;

  allowed: boolean;
  msgs: ChatCompletionMessageParam[];
  terminated: boolean;
}

export type Phase = (ctx: ToolCallContext) => Promise<void>;

export function createContext(input: {
  tc: { id: string; name: string; arguments: string };
  toolMap: Map<string, ToolDefinition>;
  security: SecurityLayer;
  toolPolicy?: ToolPolicy;
  threatEngine?: ThreatEngine;
  rbac?: RBACManager;
  callerRole?: Role;
  sessionId?: string;
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
    onEvent: input.onEvent,
    signal: input.signal,
    priorMessages: input.priorMessages,
    callContext: "local",
    args: {},
    riskLevel: "low",
    approvalContext: "",
    preBlocked: false,
    allowed: true,
    msgs: [],
    terminated: false,
  };
}

// Build the final tool msg, emit tool_end, and stop the phase chain.
// `rendered: "raw"` writes content verbatim (used by paths that build a
// human-readable string directly). `rendered: "model"` runs the content
// through renderToolResultForModel for ToolResult-shaped values.
export function terminate(
  ctx: ToolCallContext,
  payload:
    | { rendered: "raw"; content: string; allowed: boolean }
    | { rendered: "model"; result: ToolResult; allowed: boolean },
): void {
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
  ctx.terminated = true;
}
