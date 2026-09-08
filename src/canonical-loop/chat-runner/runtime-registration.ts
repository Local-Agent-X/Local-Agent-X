import { estimateTokens } from "../../context-manager/token-estimation.js";
import { makeChatToolDispatcher } from "../chat-tool-dispatcher.js";
import {
  registerOpBaselineTokens,
  registerToolDispatcherForOp,
  registerToolsForOp,
  unregisterAdapterForOp,
  unregisterOpBaselineTokens,
  unregisterToolDispatcherForOp,
  unregisterToolsForOp,
} from "../runtime.js";
import type { CanonicalChatContext } from "../chat-runner.js";
import { registerAdapterForChat } from "./register-adapter.js";
import type { OpenAICompatTarget } from "../adapters/openai-compat.js";

export interface ChatRuntimeRegistration {
  dispose(): void;
}

export async function registerChatRuntime(
  opId: string,
  ctx: CanonicalChatContext,
  signal: AbortSignal,
  resolvedTarget: OpenAICompatTarget | null,
): Promise<ChatRuntimeRegistration> {
  const toolDescriptors = ctx.tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters,
  }));

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    unregisterAdapterForOp(opId);
    unregisterToolDispatcherForOp(opId);
    unregisterToolsForOp(opId);
    unregisterOpBaselineTokens(opId);
  };

  try {
    await registerAdapterForChat(opId, ctx.prepared, ctx.sessionId, resolvedTarget);
    registerToolDispatcherForOp(opId, makeChatToolDispatcher({
      tools: ctx.tools,
      security: ctx.security,
      toolPolicy: ctx.toolPolicy,
      threatEngine: ctx.threatEngine,
      rbac: ctx.rbac,
      callerRole: ctx.callerRole,
      sessionId: ctx.sessionId,
      callContext: "local",
      opId,
      onEvent: ctx.onToolEvent,
      signal,
    }));
    registerToolsForOp(opId, toolDescriptors);
    // Registered for EVERY model, not only Anthropic. The system prompt and
    // tool manifest are sent outside `messages` on every adapter, so every
    // adapter's history sizing under-counts by exactly this much without it.
    // Incident 2026-09-08: a local 65k-window model was gated on the raw
    // window, history grew until the ~13k-token tool manifest no longer fit,
    // and the adapter stripped tools mid-turn. The kill switch
    // (LAX_CONTEXT_BASELINE=0) lives at the consumer (turn-loop/build-input.ts).
    registerOpBaselineTokens(
      opId,
      estimateTokens(ctx.prepared.systemPrompt) + estimateTokens(JSON.stringify(toolDescriptors)),
    );
    return { dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
