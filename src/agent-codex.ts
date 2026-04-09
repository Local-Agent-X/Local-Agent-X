import type {
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions.js";
import type { ToolDefinition, AgentTurn, ServerEvent } from "./types.js";
import type { SecurityLayer } from "./security.js";
import type { ToolPolicy } from "./tool-policy.js";
import type { ThreatEngine } from "./threat-engine.js";
import type { RBACManager, Role } from "./rbac.js";
import { streamCodexResponse } from "./codex-client.js";
import { executeToolCalls, checkAndCompact } from "./tool-executor.js";

interface ImageAttachment {
  url: string;
  filePath?: string;
  name: string;
}

interface AgentOptions {
  apiKey: string;
  model: string;
  baseURL?: string;
  provider: "xai" | "openai" | "codex" | "anthropic" | "local" | "gemini" | "custom";
  systemPrompt: string;
  tools: ToolDefinition[];
  security: SecurityLayer;
  toolPolicy?: ToolPolicy;
  threatEngine?: ThreatEngine;
  rbac?: RBACManager;
  callerRole?: Role;
  sessionId?: string;
  maxIterations?: number;
  temperature?: number;
  images?: ImageAttachment[];
  onEvent?: (event: ServerEvent) => void;
  signal?: AbortSignal;
  pauseCallback?: (reason: string) => Promise<string>;
}

// ── Codex (ChatGPT subscription) Agent Loop ──
//
// Codex tool calls are routed through the canonical tool-executor in
// runCodexAgentHttp(), so they get the same security, hooks, retry,
// circuit breaker, rate limiting, and tracker treatment as Anthropic/xAI.
// (The previous WebSocket path was disabled in production and bypassed
// the executor entirely — it has been removed to prevent that drift.)

export async function runCodexAgent(
  userMessage: string,
  history: ChatCompletionMessageParam[],
  options: AgentOptions
): Promise<AgentTurn> {
  return runCodexAgentHttp(userMessage, history, options);
}

// ── HTTP path (canonical) ──

export async function runCodexAgentHttp(
  userMessage: string,
  history: ChatCompletionMessageParam[],
  options: AgentOptions
): Promise<AgentTurn> {
  const { apiKey, model, systemPrompt, tools, security, maxIterations = 25, onEvent, signal } = options;
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  type VisionContentPart =
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } };
  let userContent: string | VisionContentPart[] = userMessage;
  if (options.images && options.images.length > 0) {
    const parts: VisionContentPart[] = [{ type: "text", text: userMessage }];
    for (const img of options.images) {
      try {
        const { readFileSync } = await import("node:fs");
        const data = readFileSync(img.filePath || "");
        const ext = (img.name.split(".").pop() || "png").toLowerCase();
        const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
        parts.push({ type: "image_url", image_url: { url: `data:${mime};base64,${data.toString("base64")}`, detail: "auto" } });
      } catch (e) { console.warn(`[agent] Could not read image ${img.name}:`, e); }
    }
    userContent = parts;
  }

  let messages: ChatCompletionMessageParam[] = [...history, { role: "user", content: userContent } as ChatCompletionMessageParam];
  let totalInput = 0, totalOutput = 0;
  let previousResponseId: string | undefined;
  const codexTools = tools.map((t) => ({ type: "function" as const, name: t.name, description: t.description, parameters: t.parameters }));

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (signal?.aborted) return { messages: [{ role: "system", content: systemPrompt }, ...messages], usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput }, stopReason: "abort" };

    messages = checkAndCompact(messages, model, onEvent);

    let assistantContent = "";
    const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];

    const streamMessages = previousResponseId
      ? messages.slice(-toolCalls.length * 2)
      : messages;

    const forceToolUse = iteration > 0 && iteration < 4;

    try {
      const stream = streamCodexResponse({
        token: apiKey,
        model,
        messages: streamMessages,
        systemPrompt,
        tools: codexTools,
        previousResponseId,
        forceToolUse,
      });

      for await (const event of stream) {
        if (event.type === "text") { assistantContent += event.delta; onEvent?.({ type: "stream", delta: event.delta }); }
        else if (event.type === "tool_call") { toolCalls.push({ id: event.id, name: event.name, arguments: event.arguments }); }
        else if (event.type === "done") {
          totalInput += event.usage.inputTokens;
          totalOutput += event.usage.outputTokens;
          if (event.responseId) previousResponseId = event.responseId;
        }
      }
    } catch (e) {
      const errMsg = (e as Error).message || "Stream error";
      console.error("[agent] Codex HTTP stream error:", errMsg);
      onEvent?.({ type: "error", message: errMsg });
      return {
        messages: [{ role: "system", content: systemPrompt }, ...messages],
        usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput },
        stopReason: "error",
      };
    }

    // Detect empty response (no text, no tool calls).
    // Real causes (in order of frequency):
    //   1. gpt-5.3-codex is a CODING model — it returns nothing for casual
    //      chat messages like "hey". This is NOT moderation.
    //   2. The system prompt is too long / biases the model to call a tool
    //      that doesn't fit the user's request.
    //   3. Actual content moderation (rare for benign messages).
    // The placeholder is marked __EMPTY_CODEX_RESPONSE__ so the bridge
    // handler can detect it and fall back to a different provider, and so
    // stripEphemeralMessages can scrub it from the saved session.
    if (toolCalls.length === 0 && !assistantContent.trim()) {
      const placeholder = "__EMPTY_CODEX_RESPONSE__ (gpt-5.3-codex returned no output. This model is optimized for coding tasks; casual chat messages often produce empty responses. Trying a fallback provider...)";
      const errorMsg: ChatCompletionMessageParam = { role: "assistant", content: placeholder };
      messages.push(errorMsg);
      onEvent?.({ type: "stream", delta: placeholder });
      onEvent?.({ type: "done", usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput } });
      return { messages: [{ role: "system", content: systemPrompt }, ...messages], usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput }, stopReason: "end_turn" };
    }

    const assistantMsg: ChatCompletionMessageParam = { role: "assistant", content: assistantContent || null };
    if (toolCalls.length > 0) { (assistantMsg as unknown as Record<string, unknown>).tool_calls = toolCalls.map((tc) => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: tc.arguments } })); }
    messages.push(assistantMsg);

    if (toolCalls.length === 0) {
      onEvent?.({ type: "done", usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput } });
      return { messages: [{ role: "system", content: systemPrompt }, ...messages], usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput }, stopReason: "end_turn" };
    }

    const toolResults = await executeToolCalls(toolCalls, toolMap, security, options.toolPolicy, options.threatEngine, options.rbac, options.callerRole, options.sessionId, onEvent, signal);
    messages.push(...toolResults);

    if (assistantContent && /\b(login required|password needed|authentication required|access denied|need.+log.?in|blocked|cannot access)\b/i.test(assistantContent)) {
      if (options.pauseCallback) {
        onEvent?.({ type: "stream", delta: "\n\n[Waiting for user input...]" });
        const userResponse = await options.pauseCallback(assistantContent);
        messages.push({ role: "user", content: userResponse });
        continue;
      }
    }
  }

  return { messages: [{ role: "system", content: systemPrompt }, ...messages], usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput }, stopReason: "max_iterations" };
}
