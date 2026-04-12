import type {
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions.js";
import type { ToolDefinition, AgentTurn, ServerEvent } from "./types.js";
import type { SecurityLayer } from "./security.js";
import type { ToolPolicy } from "./tool-policy.js";
import type { ThreatEngine } from "./threat-engine.js";
import type { RBACManager, Role } from "./rbac.js";
import { streamCodexResponse, type ReasoningItem } from "./codex-client.js";
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
  // Track how many messages existed before each turn so we can compute
  // incremental input (tool results only) for the next request.
  let lastContextLength = 0;
  const codexTools = tools.map((t) => ({ type: "function" as const, name: t.name, description: t.description, parameters: t.parameters }));

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (signal?.aborted) return { messages: [{ role: "system", content: systemPrompt }, ...messages], usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput }, stopReason: "abort" };

    messages = checkAndCompact(messages, model, onEvent);

    let assistantContent = "";
    const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
    let turnReasoning: ReasoningItem[] = [];

    // Incremental mode: when we have a previousResponseId AND the only new
    // messages since our last turn are tool results, send just those results
    // instead of the full conversation. This saves input tokens and avoids
    // re-sending the entire history on every tool-call loop.
    let streamMessages: ChatCompletionMessageParam[];
    let turnPreviousResponseId: string | undefined;
    if (previousResponseId && lastContextLength > 0) {
      const newMessages = messages.slice(lastContextLength);
      const allToolResults = newMessages.length > 0 && newMessages.every(
        (m) => m.role === "tool" || (m.role === "assistant" && (m as unknown as Record<string, unknown>).tool_calls)
      );
      if (allToolResults) {
        // Incremental: only send the new tool result messages
        streamMessages = newMessages;
        turnPreviousResponseId = previousResponseId;
      } else {
        // Full context restart — something other than tool results was added
        streamMessages = messages;
        turnPreviousResponseId = undefined;
      }
    } else {
      streamMessages = messages;
    }

    lastContextLength = messages.length;

    // Only force tool use on iteration 1 (right after a nudge), not on every turn
    const forceToolUse = false; // Disabled — tool_choice "required" causes loops

    try {
      const stream = streamCodexResponse({
        token: apiKey,
        model,
        messages: streamMessages,
        systemPrompt,
        tools: codexTools,
        previousResponseId: turnPreviousResponseId,
        forceToolUse,
        sessionId: options.sessionId,
      });

      for await (const event of stream) {
        if (event.type === "text") { assistantContent += event.delta; onEvent?.({ type: "stream", delta: event.delta }); }
        else if (event.type === "tool_call") { toolCalls.push({ id: event.id, name: event.name, arguments: event.arguments }); }
        else if (event.type === "reasoning") { turnReasoning.push(event.item); }
        else if (event.type === "done") {
          totalInput += event.usage.inputTokens;
          totalOutput += event.usage.outputTokens;
          if (event.responseId) previousResponseId = event.responseId;
          // Merge any reasoning from the done event that wasn't streamed
          if (event.reasoning.length > 0 && turnReasoning.length === 0) {
            turnReasoning = event.reasoning;
          }
        }
      }
    } catch (e) {
      const errMsg = (e as Error).message || "Stream error";
      console.error("[agent] Codex HTTP stream error:", errMsg);
      onEvent?.({ type: "error", message: errMsg });
      // On error, invalidate previousResponseId so the next attempt
      // sends the full context instead of trying incremental mode
      previousResponseId = undefined;
      return {
        messages: [{ role: "system", content: systemPrompt }, ...messages],
        usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput },
        stopReason: "error",
      };
    }

    // Empty response — retry once silently. Codex sometimes returns empty on
    // the first attempt but succeeds on immediate retry.
    if (toolCalls.length === 0 && !assistantContent.trim()) {
      console.warn(`[agent] Codex returned empty response (iteration ${iteration}, ${totalInput}in/${totalOutput}out tokens) — retrying`);
      // Retry without previousResponseId to force full context
      previousResponseId = undefined;
      try {
        let retryText = "";
        const retryStream = streamCodexResponse({ token: apiKey, model, messages, systemPrompt, tools: codexTools });
        for await (const event of retryStream) {
          if (event.type === "text") { retryText += event.delta; onEvent?.({ type: "stream", delta: event.delta }); }
          else if (event.type === "reasoning") { turnReasoning.push(event.item); }
          else if (event.type === "done") {
            totalInput += event.usage.inputTokens;
            totalOutput += event.usage.outputTokens;
            if (event.responseId) previousResponseId = event.responseId;
            if (event.reasoning.length > 0 && turnReasoning.length === 0) turnReasoning = event.reasoning;
          }
        }
        if (retryText.trim()) assistantContent = retryText;
      } catch (e) {
        console.error(`[agent] Codex retry failed:`, (e as Error).message);
      }
    }

    // Build the assistant message, attaching reasoning items as _reasoning
    // metadata so they can be replayed in convertMessagesToInput() on the
    // next turn. The Responses API requires reasoning to be present.
    const assistantMsg: ChatCompletionMessageParam = { role: "assistant", content: assistantContent || null };
    const assistantRecord = assistantMsg as unknown as Record<string, unknown>;
    if (toolCalls.length > 0) {
      assistantRecord.tool_calls = toolCalls.map((tc) => ({
        id: tc.id, type: "function", function: { name: tc.name, arguments: tc.arguments },
      }));
    }
    if (turnReasoning.length > 0) {
      assistantRecord._reasoning = turnReasoning;
    }
    messages.push(assistantMsg);

    if (toolCalls.length === 0) {
      // Hallucination detection: if the model claims to have CREATED something
      // without calling a tool, nudge it ONCE (not for deletions or queries)
      const creationClaim = /\b(created|scheduled|saved|built|deployed|sent|posted)\b.*\b(task|schedule|mission|job|file|app|message|memory|fact)\b/i.test(assistantContent);
      const hasToolLikeIds = /\b(sched_|job_|id:|ID:)\s*[a-zA-Z0-9_-]{6,}/i.test(assistantContent);
      if ((creationClaim || hasToolLikeIds) && iteration === 0) {
        console.warn(`[agent] Hallucination detected — model claimed creation without tool call, nudging once`);
        messages.push({ role: "user", content: "You claimed to have created or scheduled something but you did NOT actually call a tool. The action did NOT happen. Call the actual tool now." } as ChatCompletionMessageParam);
        continue;
      }
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
