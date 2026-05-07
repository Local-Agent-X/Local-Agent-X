/**
 * Bridge: canonical-loop ToolDispatcher → chat's executeToolCalls.
 *
 * Why this exists: the canonical-loop has its own `ToolCall`/`ToolDispatchResult`
 * shape. The chat tool runtime (`tool-executor.ts`) takes a different shape
 * with security context, RBAC, threat engine, session callbacks, etc. This
 * module is the per-op closure that wires one to the other so a chat op
 * running through canonical can use the SAME tool implementations the
 * legacy chat path uses — no duplication, no second tool registry.
 *
 * Per-op scope: `registerToolDispatcherForOp(opId, makeChatToolDispatcher(...))`
 * captures the chat session's security/RBAC/event callback. When the op
 * terminates, the chat runner calls `unregisterToolDispatcherForOp(opId)`
 * so the closure GC'd.
 */
import type { ToolDispatcher, ToolDispatchResult } from "./tool-dispatch.js";
import type { ToolCall } from "./contract-types.js";
import type { ToolDefinition, ServerEvent } from "../types.js";
import type { SecurityLayer } from "../security.js";
import type { ToolPolicy } from "../tool-policy.js";
import type { ThreatEngine } from "../threat-engine.js";
import type { RBACManager, Role } from "../rbac.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { executeToolCalls } from "../tool-executor.js";

export interface ChatToolDispatcherOptions {
  tools: ToolDefinition[];
  security: SecurityLayer;
  toolPolicy?: ToolPolicy;
  threatEngine?: ThreatEngine;
  rbac?: RBACManager;
  callerRole?: Role;
  sessionId: string;
  onEvent?: (event: ServerEvent) => void;
  signal?: AbortSignal;
}

/**
 * Build a canonical-loop `ToolDispatcher` that delegates to the chat tool
 * runtime. The closure captures session-scoped context — register one per
 * op via `registerToolDispatcherForOp`.
 */
export function makeChatToolDispatcher(opts: ChatToolDispatcherOptions): ToolDispatcher {
  const toolMap = new Map(opts.tools.map(t => [t.name, t]));

  return {
    async dispatch(call: ToolCall): Promise<ToolDispatchResult> {
      const t0 = Date.now();
      const argsJson = (() => {
        try { return JSON.stringify(call.args ?? {}); }
        catch { return "{}"; }
      })();

      try {
        const messages = await executeToolCalls(
          [{ id: call.toolCallId, name: call.tool, arguments: argsJson }],
          toolMap,
          opts.security,
          opts.toolPolicy,
          opts.threatEngine,
          opts.rbac,
          opts.callerRole,
          opts.sessionId,
          opts.onEvent,
          opts.signal,
          /* priorMessages */ undefined,
        );

        // executeToolCalls returns 1+ ChatCompletionMessageParam. Pull the
        // first tool-role message — that's the canonical "result" payload.
        // Other roles (e.g. injected user messages from some tools) are
        // not part of the canonical result contract; drop them. If no tool
        // message came back, surface the issue as an error result.
        const toolMsg = messages.find(m => m.role === "tool") as
          | (ChatCompletionMessageParam & { role: "tool"; content: string | unknown })
          | undefined;

        if (!toolMsg) {
          return {
            toolCallId: call.toolCallId,
            status: "error",
            result: { error: `tool '${call.tool}' produced no result message` },
            durationMs: Date.now() - t0,
          };
        }

        const content = typeof toolMsg.content === "string"
          ? toolMsg.content
          : JSON.stringify(toolMsg.content);

        return {
          toolCallId: call.toolCallId,
          status: "ok",
          result: content,
          durationMs: Date.now() - t0,
        };
      } catch (e) {
        return {
          toolCallId: call.toolCallId,
          status: "error",
          result: { error: (e as Error).message },
          durationMs: Date.now() - t0,
        };
      }
    },
  };
}
