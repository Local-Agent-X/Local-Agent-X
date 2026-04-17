import OpenAI from "openai";
import { readdirSync, existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type {
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions.js";
import type { ToolDefinition, AgentTurn, ServerEvent } from "./types.js";
import type { SecurityLayer } from "./security.js";
import type { ToolPolicy } from "./tool-policy.js";
import type { ThreatEngine } from "./threat-engine.js";
import type { RBACManager, Role } from "./rbac.js";
import { streamAnthropicResponse } from "./anthropic-client.js";
import { executeToolCalls, toolsToOpenAI, checkAndCompact } from "./tool-executor.js";
import { getRuntimeConfig } from "./config.js";
import { detectUnresolvedErrors, buildReflectionPrompt, checkApprovalHallucination, checkCreationHallucination, checkToolLoops, createLoopState } from "./agent-guards.js";

/** Strip ephemeral self-check / quality-gate user messages before persisting a session. */
export function stripEphemeralMessages(messages: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
  return messages.filter((m) => {
    if (m.role === "user" && typeof m.content === "string") {
      if (m.content.startsWith("[Self-check]")) return false;
      if (m.content.startsWith("Your previous response was empty.")) return false;
      if (m.content.startsWith("Tool errors occurred but you did not address them.")) return false;
      if (m.content.startsWith("You do NOT need approval.")) return false;
      if (m.content.startsWith("You claimed to have created or scheduled")) return false;
      // NOTE: "SYSTEM: You have called ..." loop nudges are kept — the LLM must see them to stop looping
    }
    // Strip legacy empty-response placeholders so they don't pollute
    // future turns (breaks alternating-role expectation on Codex API).
    if (m.role === "assistant" && typeof m.content === "string") {
      if (m.content.includes("model returned an empty response") && m.content.length < 300) return false;
    }
    return true;
  });
}

/**
 * Sanitize a message history before sending it to a provider.
 * Strips orphaned tool_calls (assistant tool_calls without matching tool results)
 * and orphaned tool results (tool messages without matching assistant calls).
 *
 * The OpenAI Responses API in particular silently rejects requests with
 * malformed tool_call structure — the model returns zero output items, which
 * shows up as an empty response. This is the root cause of the bridge handler
 * returning empty placeholders even for benign messages like "hey".
 */
export function sanitizeHistory(messages: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
  type MsgRecord = Record<string, unknown>;
  const callIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const m of messages) {
    const rec = m as unknown as MsgRecord;
    if (m.role === "assistant" && rec.tool_calls) {
      for (const tc of rec.tool_calls as Array<{ id: string }>) callIds.add(tc.id);
    }
    if (m.role === "tool" && rec.tool_call_id) {
      resultIds.add(rec.tool_call_id as string);
    }
  }
  const orphanedCallIds = new Set([...callIds].filter((id) => !resultIds.has(id)));

  const out: ChatCompletionMessageParam[] = [];
  for (const m of messages) {
    const rec = m as unknown as MsgRecord;
    if (m.role === "assistant" && rec.tool_calls) {
      if (orphanedCallIds.size > 0) {
        const cleaned = (rec.tool_calls as Array<{ id: string }>).filter((tc) => !orphanedCallIds.has(tc.id));
        if (cleaned.length === 0) {
          if (m.content) out.push({ role: m.role, content: m.content } as ChatCompletionMessageParam);
        } else {
          out.push({ ...m, tool_calls: cleaned } as typeof m);
        }
      } else {
        out.push(m);
      }
    } else if (m.role === "tool") {
      const tid = rec.tool_call_id as string | undefined;
      if (tid && callIds.has(tid) && !orphanedCallIds.has(tid)) {
        out.push(m);
      }
    } else {
      out.push(m);
    }
  }

  // Coalesce consecutive same-role text messages. Multiple bridge messages
  // arriving back-to-back with no agent reply (3x "hey") create runs of
  // user-only messages that violate the alternating-role expectation Codex
  // enforces and cause empty responses.
  const coalesced: ChatCompletionMessageParam[] = [];
  for (const m of out) {
    const last = coalesced[coalesced.length - 1];
    if (
      last &&
      last.role === m.role &&
      (m.role === "user" || m.role === "assistant") &&
      typeof last.content === "string" &&
      typeof m.content === "string" &&
      !(last as unknown as MsgRecord).tool_calls &&
      !(m as unknown as MsgRecord).tool_calls
    ) {
      // Merge into the previous message
      (last as { content: string }).content = `${last.content}\n${m.content}`;
      continue;
    }
    coalesced.push(m);
  }
  return coalesced;
}

/**
 * Truncate a long history to a working window, with an optional summary header.
 * Cuts at the nearest user message so we never split a tool-call/tool-result pair.
 */
export function truncateHistory(messages: ChatCompletionMessageParam[], maxKeep: number = 30): ChatCompletionMessageParam[] {
  if (messages.length <= maxKeep) return messages;

  const targetIdx = messages.length - maxKeep;
  // Find nearest user message at or after target
  let cutIdx = targetIdx;
  for (let i = targetIdx; i < messages.length; i++) {
    if (messages[i].role === "user") { cutIdx = i; break; }
  }
  if (cutIdx >= messages.length) {
    for (let i = targetIdx; i >= 0; i--) {
      if (messages[i].role === "user") { cutIdx = i; break; }
    }
  }

  // Walk cutIdx backward if we'd split a tool_call/tool_result pair
  // (assistant with tool_calls must be followed by its tool results)
  if (cutIdx > 0 && messages[cutIdx - 1]?.role === "assistant") {
    const prev = messages[cutIdx - 1] as unknown as Record<string, unknown>;
    if (prev.tool_calls && Array.isArray(prev.tool_calls)) {
      // The assistant before the cut has tool_calls — include it and its results
      cutIdx = cutIdx - 1;
      // Also include all following tool result messages
      while (cutIdx + 1 < messages.length && messages[cutIdx + 1]?.role === "tool") {
        // These will be included in 'recent' anyway since cutIdx moved back
      }
    }
  }
  // Also skip forward past any orphaned tool results at the start of recent
  while (cutIdx < messages.length && messages[cutIdx]?.role === "tool") {
    cutIdx++;
  }

  const old = messages.slice(0, cutIdx);
  const recent = messages.slice(cutIdx);

  // Build a one-line summary so the model knows the conversation has prior context
  const summaryLines: string[] = [];
  for (const m of old) {
    if (m.role === "user" && typeof m.content === "string") {
      summaryLines.push(`User: ${m.content.slice(0, 150).replace(/\n/g, " ")}`);
    } else if (m.role === "assistant" && typeof m.content === "string") {
      const firstLine = m.content.split("\n").filter((l) => l.trim())[0] || "";
      summaryLines.push(`Agent: ${firstLine.slice(0, 150)}`);
    }
  }
  const summary = `[Earlier in this conversation (${old.length} messages summarized):\n${summaryLines.join("\n")}\n...end of summary]`;

  return [{ role: "system", content: summary } as ChatCompletionMessageParam, ...recent];
}

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

// Cache of local models that don't support tool calling
const _localNoToolModels = new Set<string>();

// ── Standard (xAI/OpenAI API) Agent Loop ──

export async function runStandardAgent(
  userMessage: string,
  history: ChatCompletionMessageParam[],
  options: AgentOptions
): Promise<AgentTurn> {
  const {
    apiKey,
    model,
    systemPrompt,
    tools,
    security,
    maxIterations = 25,
    temperature = 0.7,
    onEvent,
    signal,
  } = options;

  const providerURLs: Record<string, string> = {
    local: `${getRuntimeConfig().ollamaUrl}/v1`,
    xai: "https://api.x.ai/v1",
    gemini: "https://generativelanguage.googleapis.com/v1beta/openai/",
    openai: "https://api.openai.com/v1",
    codex: "https://api.openai.com/v1",
    anthropic: "https://api.openai.com/v1",
    custom: "https://api.openai.com/v1",
  };
  const baseURL = options.baseURL || providerURLs[options.provider] || "https://api.openai.com/v1";
  const client = new OpenAI({ apiKey, baseURL });
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  // Build user message — include images as vision content parts if present
  let userContent: ChatCompletionMessageParam["content"];
  if (options.images && options.images.length > 0) {
    const parts: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail?: string } }> = [
      { type: "text", text: userMessage },
    ];
    for (const img of options.images) {
      try {
        const { readFileSync } = await import("node:fs");
        const data = readFileSync(img.filePath || "");
        const ext = (img.name.split(".").pop() || "png").toLowerCase();
        const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
        const b64 = `data:${mime};base64,${data.toString("base64")}`;
        parts.push({ type: "image_url", image_url: { url: b64, detail: "auto" } });
      } catch (e) {
        console.warn(`[agent] Could not read image ${img.name}:`, e);
      }
    }
    userContent = parts as ChatCompletionMessageParam["content"];
  } else {
    userContent = userMessage;
  }

  let messages: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: userContent } as ChatCompletionMessageParam,
  ];

  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  const loopState = createLoopState();
  let selfCheckFired = false;

  // Force tool use on first iteration for build/action intents
  const BUILD_INTENT_RE = /\b(build|create|make|write|generate|scaffold|set up)\s+(me\s+)?(a\s+|an\s+|the\s+)?(app|bot|dashboard|tracker|tool|game|website|page|site|form|calculator|chat|api|script|file|document|spreadsheet)/i;
  const ACTION_INTENT_RE = /\b(schedule|save|remember|send|post|delete|update|run|execute|launch|open|close|deploy|install)\b/i;
  const shouldForceTools = BUILD_INTENT_RE.test(userMessage) || ACTION_INTENT_RE.test(userMessage);

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (iteration > 0) messages = stripEphemeralMessages(messages);
    messages = checkAndCompact(messages, model, onEvent);

    if (signal?.aborted) {
      return {
        messages,
        usage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens, totalTokens: totalPromptTokens + totalCompletionTokens },
        stopReason: "abort",
      };
    }

    let assistantContent = "";
    const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];

    try {
      const useTools = !_localNoToolModels.has(model);
      // tool_choice: "required" disabled — causes empty responses on some models (Grok, Codex)
      let stream = await client.chat.completions.create({
        model,
        messages,
        ...(useTools ? { tools: toolsToOpenAI(tools) } : {}),
        temperature,
        stream: true,
      }, { signal: signal || undefined }).catch(async (err: Error) => {
        if (options.provider === "local" && err.message?.includes("does not support tools")) {
          _localNoToolModels.add(model);
          console.log(`[agent] Model ${model} doesn't support tools — switching to chat-only mode`);
          return client.chat.completions.create({
            model,
            messages,
            temperature,
            stream: true,
          }, { signal: signal || undefined });
        }
        throw err;
      });

      let finishReason: string | undefined;
      for await (const chunk of stream) {
        if (signal?.aborted) {
          stream.controller.abort();
          break;
        }
        const choice = chunk.choices[0];
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        const delta = choice?.delta;
        if (!delta) continue;

        if (delta.content) {
          assistantContent += delta.content;
          onEvent?.({ type: "stream", delta: delta.content });
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (tc.index !== undefined) {
              while (toolCalls.length <= tc.index) {
                toolCalls.push({ id: "", name: "", arguments: "" });
              }
              if (tc.id) toolCalls[tc.index].id = tc.id;
              if (tc.function?.name) toolCalls[tc.index].name = tc.function.name;
              if (tc.function?.arguments) toolCalls[tc.index].arguments += tc.function.arguments;
            }
          }
        }

        if (chunk.usage) {
          totalPromptTokens += chunk.usage.prompt_tokens || 0;
          totalCompletionTokens += chunk.usage.completion_tokens || 0;
        }
      }

      // Classify the response
      const { classifyOpenAIResponse, logClassification } = await import("./response-classifier.js");
      const classification = classifyOpenAIResponse({
        hasText: !!assistantContent.trim(),
        hasToolCalls: toolCalls.length > 0,
        finishReason,
        inputTokens: totalPromptTokens,
        outputTokens: totalCompletionTokens,
      });
      logClassification(options.provider, model, classification);
    } catch (e) {
      const errMsg = (e as Error).message || "Stream error";
      console.error("[agent] Standard stream error:", errMsg);
      const { classifyOpenAIResponse, logClassification } = await import("./response-classifier.js");
      const classification = classifyOpenAIResponse({
        hasText: !!assistantContent.trim(),
        hasToolCalls: toolCalls.length > 0,
        errorMessage: errMsg,
      });
      logClassification(options.provider, model, classification);
      onEvent?.({ type: "error", message: errMsg });
      return {
        messages,
        usage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens, totalTokens: totalPromptTokens + totalCompletionTokens },
        stopReason: "error",
      };
    }

    const assistantMsg: ChatCompletionMessageParam = {
      role: "assistant",
      content: assistantContent || null,
    };
    if (toolCalls.length > 0) {
      (assistantMsg as unknown as Record<string, unknown>).tool_calls = toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.arguments },
      }));
    }
    messages.push(assistantMsg);

    if (toolCalls.length === 0) {
      // Approval hallucination
      const approvalNudge = checkApprovalHallucination(assistantContent);
      if (approvalNudge && iteration < maxIterations - 1) {
        console.warn(`[agent] Approval hallucination detected — nudging`);
        messages.push({ role: "user", content: approvalNudge } as ChatCompletionMessageParam);
        continue;
      }

      // Creation hallucination
      const creationNudge = checkCreationHallucination(assistantContent);
      if (creationNudge && iteration === 0) {
        console.warn(`[agent] Creation hallucination detected — nudging`);
        messages.push({ role: "user", content: creationNudge } as ChatCompletionMessageParam);
        continue;
      }

      // Self-check: unresolved tool errors (cap at one per run)
      const unresolvedErrors = !selfCheckFired ? detectUnresolvedErrors(messages) : [];
      if (unresolvedErrors.length > 0 && iteration < maxIterations - 1) {
        selfCheckFired = true;
        messages.push({ role: "user", content: buildReflectionPrompt(unresolvedErrors) } as ChatCompletionMessageParam);
        continue;
      }

      onEvent?.({
        type: "done",
        usage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens, totalTokens: totalPromptTokens + totalCompletionTokens },
      });
      return {
        messages,
        usage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens, totalTokens: totalPromptTokens + totalCompletionTokens },
        stopReason: "end_turn",
      };
    }

    // Loop detection
    const loopResult = checkToolLoops(toolCalls, loopState);
    if (loopResult.abort) {
      onEvent?.({ type: "stream", delta: loopResult.nudge || "" });
      return { messages, usage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens, totalTokens: totalPromptTokens + totalCompletionTokens }, stopReason: "end_turn" };
    }
    if (loopResult.nudge) {
      messages.push({ role: "user", content: loopResult.nudge } as ChatCompletionMessageParam);
    }

    let toolResults;
    try {
      toolResults = await executeToolCalls(toolCalls, toolMap, security, options.toolPolicy, options.threatEngine, options.rbac, options.callerRole, options.sessionId, onEvent, signal);
    } catch (e) {
      console.error("[agent] Tool execution error (Standard):", (e as Error).message);
      toolResults = [{ role: "tool" as const, content: `Tool execution failed: ${(e as Error).message}`, tool_call_id: toolCalls[0]?.id || "unknown" }];
    }
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

  return {
    messages,
    usage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens, totalTokens: totalPromptTokens + totalCompletionTokens },
    stopReason: "max_iterations",
  };
}

// ── Anthropic (Claude) Agent Loop ──

export async function runAnthropicAgent(
  userMessage: string,
  history: ChatCompletionMessageParam[],
  options: AgentOptions
): Promise<AgentTurn> {
  const { apiKey, model, systemPrompt, tools, security, maxIterations = 25, temperature = 0.7, onEvent, signal } = options;
  const toolMap = new Map(tools.map(t => [t.name, t]));

  // Build user message — attach images as vision parts when present.
  // Anthropic accepts OpenAI-style content arrays; anthropic-client.convertUserContent
  // translates image_url data URLs to Anthropic's base64 image format.
  let userContent: ChatCompletionMessageParam["content"] = userMessage;
  if (options.images && options.images.length > 0) {
    const parts: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail?: string } }> = [
      { type: "text", text: userMessage },
    ];
    for (const img of options.images) {
      try {
        const { readFileSync } = await import("node:fs");
        const data = readFileSync(img.filePath || "");
        const ext = (img.name.split(".").pop() || "png").toLowerCase();
        const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
        const b64 = `data:${mime};base64,${data.toString("base64")}`;
        parts.push({ type: "image_url", image_url: { url: b64, detail: "auto" } });
      } catch (e) {
        console.warn(`[agent] Could not read image ${img.name}:`, e);
      }
    }
    userContent = parts as ChatCompletionMessageParam["content"];
  }

  let messages: ChatCompletionMessageParam[] = [
    ...history,
    { role: "user", content: userContent } as ChatCompletionMessageParam,
  ];

  let totalInput = 0, totalOutput = 0;
  let selfCheckFiredAnthropic = false;
  const loopStateAnthropic = createLoopState();
  const anthropicTools = tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters }));

  // Force tool use on first iteration for build/action intents
  const BUILD_INTENT_RE_A = /\b(build|create|make|write|generate|scaffold|set up)\s+(me\s+)?(a\s+|an\s+|the\s+)?(app|bot|dashboard|tracker|tool|game|website|page|site|form|calculator|chat|api|script|file|document|spreadsheet)/i;
  const ACTION_INTENT_RE_A = /\b(schedule|save|remember|send|post|delete|update|run|execute|launch|open|close|deploy|install)\b/i;
  const shouldForceToolsA = BUILD_INTENT_RE_A.test(userMessage) || ACTION_INTENT_RE_A.test(userMessage);

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (iteration > 0) messages = stripEphemeralMessages(messages);
    messages = checkAndCompact(messages, model, onEvent);
    if (signal?.aborted) {
      return { messages: [{ role: "system", content: systemPrompt }, ...messages], usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput }, stopReason: "abort" };
    }

    let assistantContent = "";
    const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];

    const stream = streamAnthropicResponse({
      token: apiKey,
      model,
      messages,
      systemPrompt,
      tools: anthropicTools,
      temperature,
      toolChoice: (iteration === 0 && shouldForceToolsA) ? "required" : "auto",
    });

    let streamError: string | null = null;
    for await (const event of stream) {
      if (event.type === "text") {
        assistantContent += event.delta;
        onEvent?.({ type: "stream", delta: event.delta || "" });
      } else if (event.type === "tool_call") {
        toolCalls.push({ id: event.id!, name: event.name!, arguments: event.arguments! });
      } else if (event.type === "done") {
        totalInput += event.usage?.inputTokens || 0;
        totalOutput += event.usage?.outputTokens || 0;
      } else if (event.type === "error") {
        streamError = event.error || "Anthropic error";
        onEvent?.({ type: "error", message: streamError });
      }
    }
    if (streamError) {
      return { messages, usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput }, stopReason: "error" };
    }

    const assistantMsg: ChatCompletionMessageParam = { role: "assistant", content: assistantContent || null };
    if (toolCalls.length > 0) {
      (assistantMsg as unknown as Record<string, unknown>).tool_calls = toolCalls.map(tc => ({
        id: tc.id, type: "function", function: { name: tc.name, arguments: tc.arguments },
      }));
    }
    messages.push(assistantMsg);

    // Auto-route to build_app if Claude tried to write files directly (skip for IDE sessions)
    const hasBuildApp = tools.some(t => t.name === "build_app");
    if (toolCalls.length === 0 && hasBuildApp && detectBuildIntent(assistantContent, userMessage)) {
      const appName = extractAppName(assistantContent, userMessage);
      const buildPrompt = extractBuildPrompt(assistantContent, userMessage);
      console.log(`[agent] Auto-routing to build_app: ${appName}`);
      onEvent?.({ type: "stream", delta: "\n\n*Building app...*\n" });
      toolCalls.push({
        id: `call_${Date.now()}_build_app`,
        name: "build_app",
        arguments: JSON.stringify({ name: appName, prompt: buildPrompt }),
      });
      (assistantMsg as unknown as Record<string, unknown>).tool_calls = toolCalls.map(tc => ({
        id: tc.id, type: "function", function: { name: tc.name, arguments: tc.arguments },
      }));
    }

    if (toolCalls.length === 0) {
      const approvalNudge = checkApprovalHallucination(assistantContent);
      if (approvalNudge && iteration < maxIterations - 1) {
        console.warn(`[agent] Approval hallucination detected (Anthropic) — nudging`);
        messages.push({ role: "user", content: approvalNudge } as ChatCompletionMessageParam);
        continue;
      }

      const creationNudge = checkCreationHallucination(assistantContent);
      if (creationNudge && iteration === 0) {
        console.warn(`[agent] Creation hallucination detected (Anthropic) — nudging`);
        messages.push({ role: "user", content: creationNudge } as ChatCompletionMessageParam);
        continue;
      }

      const unresolvedErrors = !selfCheckFiredAnthropic ? detectUnresolvedErrors(messages) : [];
      if (unresolvedErrors.length > 0 && iteration < maxIterations - 1) {
        selfCheckFiredAnthropic = true;
        messages.push({ role: "user", content: buildReflectionPrompt(unresolvedErrors) } as ChatCompletionMessageParam);
        continue;
      }

      onEvent?.({ type: "done", usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput } });
      return { messages: [{ role: "system", content: systemPrompt }, ...messages], usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput }, stopReason: "end_turn" };
    }

    // Loop detection
    const loopResult = checkToolLoops(toolCalls, loopStateAnthropic);
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
      console.error("[agent] Tool execution error (Anthropic):", (e as Error).message);
      toolResults = [{ role: "tool" as const, content: `Tool execution failed: ${(e as Error).message}`, tool_call_id: toolCalls[0]?.id || "unknown" }];
    }
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

// ── Build intent helpers (auto-route to build_app) ──

function detectBuildIntent(response: string, userMessage: string): boolean {
  const buildKeywords = /\b(build|create|make|write|upgrade|update|improve|redesign|level.?up)\b.*\b(app|website|page|game|project|todo|site)\b/i;
  const claudeCodeSignals = /permission|allow|click allow|approve|write.*file|I'll write|I'll create the file|mkdir|workspace.apps/i;
  if (buildKeywords.test(userMessage) && claudeCodeSignals.test(response)) return true;
  if (/I'll (write|create|drop|save) (the |these |all )?files/i.test(response)) return true;
  return false;
}

function extractAppName(response: string, userMessage: string): string {
  const wsMatch = response.match(/workspace\/apps\/([a-zA-Z0-9_-]+)/);
  if (wsMatch) return wsMatch[1];
  try {
    const appsDir = resolvePath("workspace", "apps");
    if (existsSync(appsDir)) {
      const apps = readdirSync(appsDir) as string[];
      const msg = userMessage.toLowerCase();
      for (const app of apps) {
        const appWords = app.replace(/-/g, " ").toLowerCase();
        if (msg.includes(appWords) || msg.includes(app) || appWords.split(" ").some((w: string) => w.length > 3 && msg.includes(w))) {
          return app;
        }
      }
    }
  } catch {}
  const m = userMessage.match(/(?:the\s+)?([a-z][a-z0-9]+(?:[- ][a-z0-9]+)*)\s+app/i);
  if (m) return m[1].trim().toLowerCase().replace(/\s+/g, "-");
  return "my-app";
}

function extractBuildPrompt(response: string, userMessage: string): string {
  const cleanResponse = response.replace(/permission|allow|click allow|approve|Claude Code/gi, "").slice(0, 1000);
  return `User request: ${userMessage}\n\nDetails from conversation: ${cleanResponse}`;
}
