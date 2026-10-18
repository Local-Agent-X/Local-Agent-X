// One call through the real pipeline, answered as the result envelope its tool
// message carries. Tests that used to reach for a single-call dispatch entry
// use this; production has one entry, `executeToolCalls`.
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { ToolDefinition, ToolResult, ServerEvent } from "../types.js";
import type { SecurityLayer } from "../security/index.js";
import type { ToolPolicy } from "../tool-policy/index.js";
import type { ThreatEngine } from "../threat/threat-engine.js";
import type { RBACManager, Role } from "../rbac.js";
import type { CallContext } from "./context.js";
import { executeToolCalls } from "./execute-tool.js";
import { toolMessageResult } from "./tool-message-carry.js";

export interface DispatchOneCtx {
  toolMap: Map<string, ToolDefinition>;
  security: SecurityLayer;
  toolPolicy?: ToolPolicy;
  threatEngine?: ThreatEngine;
  rbac?: RBACManager;
  callerRole?: Role;
  sessionId?: string;
  runId?: string;
  operationId?: string;
  callContext?: CallContext;
  onEvent?: (event: ServerEvent) => void;
  signal?: AbortSignal;
  priorMessages?: ChatCompletionMessageParam[];
}

export async function dispatchOne(
  call: { id: string; name: string; arguments?: string; args?: Record<string, unknown> },
  ctx: DispatchOneCtx,
): Promise<ToolResult> {
  const msgs = await executeToolCalls(
    [{ id: call.id, name: call.name, arguments: call.arguments ?? JSON.stringify(call.args ?? {}) }],
    ctx.toolMap, ctx.security, ctx.toolPolicy, ctx.threatEngine, ctx.rbac, ctx.callerRole,
    ctx.sessionId, ctx.onEvent, ctx.signal, ctx.priorMessages, ctx.runId, ctx.operationId, ctx.callContext ?? "api",
  );
  const toolMsg = msgs.find((m) => m.role === "tool");
  return toolMessageResult(toolMsg ?? { content: "" });
}
