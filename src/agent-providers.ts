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

// ── Self-Reflection: checks for unresolved errors after the agent loop ──

function detectUnresolvedErrors(messages: ChatCompletionMessageParam[]): string[] {
  const errors: string[] = [];
  // Check last N tool results for failures that were never addressed
  const recentMsgs = messages.slice(-20);
  for (const m of recentMsgs) {
    if (m.role !== "tool" || typeof m.content !== "string") continue;
    const c = m.content;
    if (/\b(BLOCKED|error|failed|timed? ?out|not found|permission denied|ENOENT|EACCES|EPERM)\b/i.test(c) && c.length < 500) {
      errors.push(c.slice(0, 200));
    }
  }
  // Check if the last assistant message acknowledges errors or just ignores them
  const lastAssistant = [...recentMsgs].reverse().find(m => m.role === "assistant" && typeof m.content === "string");
  if (lastAssistant && typeof lastAssistant.content === "string") {
    // If assistant mentions the error/problem, it's probably addressed
    if (/\b(error|failed|couldn't|unable|issue|problem|unfortunately|sorry)\b/i.test(lastAssistant.content)) {
      return []; // Agent acknowledged the issue
    }
  }
  return errors;
}

function buildReflectionPrompt(errors: string[]): string {
  return `[Self-check] The following tool errors occurred but may not have been addressed in your response. If any are relevant to the user's request, briefly acknowledge what went wrong and suggest a fix. If they're irrelevant (e.g., optional lookups), ignore them.\n\nErrors:\n${errors.map((e, i) => `${i + 1}. ${e}`).join("\n")}`;
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
  let stdLastToolKey = "";
  let stdSameToolCount = 0;
  // Track same-tool-name usage to detect discovery loops (e.g. glob with different args each time)
  const toolNameCounts = new Map<string, number>();
  const DISCOVERY_LOOP_THRESHOLD = 8; // same tool called 8+ times = likely stuck

  for (let iteration = 0; iteration < maxIterations; iteration++) {
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

      for await (const chunk of stream) {
        if (signal?.aborted) {
          stream.controller.abort();
          break;
        }
        const delta = chunk.choices[0]?.delta;
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
    } catch (e) {
      const errMsg = (e as Error).message || "Stream error";
      console.error("[agent] Standard stream error:", errMsg);
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
      // Detect approval hallucination: model says "needs approval" instead of calling the tool
      const approvalHallucination = /\b(requires? approval|needs? (your )?approv|please (approve|allow|confirm)|permission (dialog|to proceed|required))\b/i.test(assistantContent);
      if (approvalHallucination && iteration < maxIterations - 1) {
        console.warn(`[agent] Approval hallucination detected — nudging model to use tools directly`);
        messages.push({ role: "user", content: "You do NOT need approval. You have full permission to run any tool. Call the bash tool directly — do not ask for permission." } as ChatCompletionMessageParam);
        continue;
      }

      // Self-reflection: check for unresolved tool errors before returning
      const unresolvedErrors = detectUnresolvedErrors(messages);
      if (unresolvedErrors.length > 0 && iteration < maxIterations - 1) {
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

    // Detect tool call loops — exact same call repeated 3x
    const stdToolKey = toolCalls.map((tc) => `${tc.name}:${tc.arguments}`).join("|");
    if (stdToolKey === stdLastToolKey) {
      stdSameToolCount++;
      if (stdSameToolCount >= 3) {
        onEvent?.({ type: "stream", delta: "\n\n(Detected repeated tool calls — stopping loop)" });
        return {
          messages,
          usage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens, totalTokens: totalPromptTokens + totalCompletionTokens },
          stopReason: "end_turn",
        };
      }
    } else {
      stdSameToolCount = 1;
      stdLastToolKey = stdToolKey;
    }

    // Detect discovery loops — same tool called many times with different args (e.g. glob stuck)
    for (const tc of toolCalls) {
      toolNameCounts.set(tc.name, (toolNameCounts.get(tc.name) || 0) + 1);
    }
    const discoveryLoopTool = [...toolNameCounts.entries()].find(([name, count]) =>
      count >= DISCOVERY_LOOP_THRESHOLD && ["glob", "web_search", "read"].includes(name)
    );
    if (discoveryLoopTool) {
      const [toolName, count] = discoveryLoopTool;
      onEvent?.({ type: "stream", delta: `\n\n(Discovery loop detected: ${toolName} called ${count} times — produce output with what you have)` });
      messages.push({ role: "user", content: `SYSTEM: You have called ${toolName} ${count} times. Stop searching and produce your final output with the information you already have. Do not make any more ${toolName} calls.` } as ChatCompletionMessageParam);
      toolNameCounts.set(toolName, 0); // Reset to give the agent one chance to comply
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

  let messages: ChatCompletionMessageParam[] = [
    ...history,
    { role: "user", content: userMessage },
  ];

  let totalInput = 0, totalOutput = 0;
  const anthropicTools = tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters }));

  for (let iteration = 0; iteration < maxIterations; iteration++) {
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
      // Detect approval hallucination
      const approvalHallucination = /\b(requires? approval|needs? (your )?approv|please (approve|allow|confirm)|permission (dialog|to proceed|required))\b/i.test(assistantContent);
      if (approvalHallucination && iteration < maxIterations - 1) {
        console.warn(`[agent] Approval hallucination detected (Anthropic) — nudging`);
        messages.push({ role: "user", content: "You do NOT need approval. You have full permission to run any tool. Call the bash tool directly — do not ask for permission." } as ChatCompletionMessageParam);
        continue;
      }

      const unresolvedErrors = detectUnresolvedErrors(messages);
      if (unresolvedErrors.length > 0 && iteration < maxIterations - 1) {
        messages.push({ role: "user", content: buildReflectionPrompt(unresolvedErrors) } as ChatCompletionMessageParam);
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
