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
import { stripEphemeralMessages } from "./agent-providers.js";
import { detectUnresolvedErrors, buildReflectionPrompt, checkApprovalHallucination, checkCreationHallucination, checkToolLoops, createLoopState, checkDeadEnd, createDeadEndState } from "./agent-guards.js";

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
  const loopState = createLoopState();
  const deadEndState = createDeadEndState();
  let selfCheckFired = false;

  // Detect build/action intent — force tool use on iteration 0 to prevent
  // the model from responding with text instead of calling a tool.
  // This mirrors upstream's pattern of using tool_choice:"required" for build requests.
  const BUILD_INTENT_RE = /\b(build|create|make|write|generate|scaffold|set up)\s+(me\s+)?(a\s+|an\s+|the\s+)?(app|bot|dashboard|tracker|tool|game|website|page|site|form|calculator|chat|api|script|file|document|spreadsheet)/i;
  const ACTION_INTENT_RE = /\b(schedule|save|remember|send|post|delete|update|run|execute|launch|open|close|deploy|install)\b/i;
  const shouldForceTools = BUILD_INTENT_RE.test(userMessage) || ACTION_INTENT_RE.test(userMessage);

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (signal?.aborted) return { messages: [{ role: "system", content: systemPrompt }, ...messages], usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput }, stopReason: "abort" };

    if (iteration > 0) messages = stripEphemeralMessages(messages);
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

    // Note: Codex subscription endpoint (chatgpt.com/backend-api) returns empty
    // responses when tool_choice:"required" is sent. Keep as "auto" for Codex.
    // Build intent is enforced via the system prompt instead.
    const toolChoice = "auto" as const;

    try {
      const stream = streamCodexResponse({
        token: apiKey,
        model,
        messages: streamMessages,
        systemPrompt,
        tools: codexTools,
        previousResponseId: turnPreviousResponseId,
        sessionId: options.sessionId,
        toolChoice,
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
          else if (event.type === "tool_call") { toolCalls.push({ id: event.id, name: event.name, arguments: event.arguments }); }
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
      // Approval hallucination: model says "needs approval" instead of calling tool
      const approvalNudge = checkApprovalHallucination(assistantContent);
      if (approvalNudge && iteration < maxIterations - 1) {
        console.warn(`[agent] Approval hallucination detected (Codex) — nudging`);
        messages.push({ role: "user", content: approvalNudge } as ChatCompletionMessageParam);
        continue;
      }

      // Creation hallucination: model claims it created/scheduled something without a tool call
      const creationNudge = checkCreationHallucination(assistantContent);
      if (creationNudge && iteration === 0) {
        console.warn(`[agent] Creation hallucination detected (Codex) — nudging`);
        messages.push({ role: "user", content: creationNudge } as ChatCompletionMessageParam);
        continue;
      }

      // Self-check: unresolved tool errors
      const unresolvedErrors = !selfCheckFired ? detectUnresolvedErrors(messages) : [];
      if (unresolvedErrors.length > 0 && iteration < maxIterations - 1) {
        selfCheckFired = true;
        messages.push({ role: "user", content: buildReflectionPrompt(unresolvedErrors) } as ChatCompletionMessageParam);
        continue;
      }

      onEvent?.({ type: "done", usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput } });
      return { messages: [{ role: "system", content: systemPrompt }, ...messages], usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput }, stopReason: "end_turn" };
    }

    // Loop detection
    const loopResult = checkToolLoops(toolCalls, loopState);
    if (loopResult.abort) {
      onEvent?.({ type: "stream", delta: loopResult.nudge || "" });
      return { messages, usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput }, stopReason: "end_turn" };
    }
    if (loopResult.nudge) {
      messages.push({ role: "user", content: loopResult.nudge } as ChatCompletionMessageParam);
    }

    let toolResults;
    try {
      toolResults = await executeToolCalls(toolCalls, toolMap, security, options.toolPolicy, options.threatEngine, options.rbac, options.callerRole, options.sessionId, onEvent, signal);
    } catch (e) {
      console.error("[agent] Tool execution error (Codex):", (e as Error).message);
      toolResults = [{ role: "tool" as const, content: `Tool execution failed: ${(e as Error).message}`, tool_call_id: toolCalls[0]?.id || "unknown" }];
    }
    messages.push(...toolResults);

    // Dead-end detection — after 3 empty/null results in a row, inject a
    // system nudge telling the agent to stop and re-plan with a different tool.
    for (const tr of toolResults) {
      const content = typeof tr.content === "string" ? tr.content : "";
      const toolName = toolCalls.find(tc => tc.id === (tr as { tool_call_id?: string }).tool_call_id)?.name || "unknown";
      const d = checkDeadEnd(toolName, content, deadEndState);
      if (d.nudge) {
        messages.push({ role: "user", content: d.nudge } as ChatCompletionMessageParam);
        break;
      }
    }

    // Tightened pause detection: only trigger when the agent explicitly asks
    // the user for help, not when it's merely narrating that a site shows a
    // login screen. Previously this fired on phrases like "the page says login
    // required" and interrupted the agent's own flow.
    if (assistantContent && /\b(please (log in|sign in|enter|provide|confirm)|need(s)? you to|waiting for you|i need your|can you (log in|sign in|paste|approve)|blocked\s+on\s+(2fa|captcha|payment))\b/i.test(assistantContent)) {
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
