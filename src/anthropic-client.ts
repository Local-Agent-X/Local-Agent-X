/**
 * Anthropic client with dual strategy:
 * 1. Claude CLI proxy (for OAuth — uses `claude -p` which handles all auth natively)
 * 2. Raw HTTP fetch (for direct API keys — sk-ant-api03-*)
 */

import { spawn } from "child_process";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { buildAnthropicRateLimitHint, normalizeAnthropicModel, unwrapAnthropicSubscriptionToken, usesAnthropicSubscriptionAuth } from "./anthropic-models.js";

interface StreamEvent {
  type: "text" | "tool_call" | "done" | "error";
  delta?: string;
  id?: string;
  name?: string;
  arguments?: string;
  usage?: { inputTokens: number; outputTokens: number };
  error?: string;
  /** Stop reason from the API — populated on done/error */
  stopReason?: string;
  /** Classification of why the response ended */
  classification?: import("./response-classifier.js").ClassificationResult;
}

interface StreamOptions {
  token: string;
  model: string;
  messages: ChatCompletionMessageParam[];
  systemPrompt: string;
  tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  temperature?: number;
  maxTokens?: number;
  /** If true, don't fall back to CLI proxy on 429 — yield error instead */
  skipCliFallback?: boolean;
  /** Force tool use: "required" makes the model call a tool. "auto" (default) lets it decide. */
  toolChoice?: "auto" | "required";
}

const API_BASE = "https://api.anthropic.com";

// Global counter — guarantees unique tool_use IDs across all CLI proxy calls
let _toolCallSeq = 0;
function newToolCallId(name: string): string {
  return `tc_${Date.now()}_${++_toolCallSeq}_${name}`;
}

function extractUserPrompt(messages: ChatCompletionMessageParam[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      const content = messages[i].content;
      return typeof content === "string" ? content : JSON.stringify(content);
    }
  }
  return "";
}

// ── Raw HTTP fetch (for direct API keys) ──

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContent[];
}

type AnthropicContent =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string } }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

/** Convert OpenAI-style user content (text OR array of text+image_url parts) to Anthropic format. */
function convertUserContent(content: unknown): string | AnthropicContent[] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  const out: AnthropicContent[] = [];
  for (const part of content as Array<Record<string, unknown>>) {
    if (part.type === "text") {
      out.push({ type: "text", text: String(part.text || "") });
    } else if (part.type === "image_url") {
      const iu = part.image_url as { url: string } | undefined;
      const url = iu?.url || "";
      // data:image/png;base64,XXXX → extract media_type + data
      const m = url.match(/^data:([^;]+);base64,(.+)$/);
      if (m) {
        out.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
      } else if (url) {
        out.push({ type: "image", source: { type: "url", url } });
      }
    }
  }
  return out.length > 0 ? out : "";
}

function convertMessages(messages: ChatCompletionMessageParam[]): AnthropicMessage[] {
  const result: AnthropicMessage[] = [];
  const seenToolUseIds = new Set<string>();

  for (const msg of messages) {
    if (msg.role === "system") continue;

    if (msg.role === "user") {
      result.push({ role: "user", content: convertUserContent(msg.content) });
    } else if (msg.role === "assistant") {
      const m = msg as unknown as Record<string, unknown>;
      const content: AnthropicContent[] = [];
      if (typeof m.content === "string" && m.content) {
        content.push({ type: "text", text: m.content });
      }
      if (m.tool_calls && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls as Array<{ id: string; function: { name: string; arguments: string } }>) {
          let input: Record<string, unknown> = {};
          try { input = JSON.parse(tc.function.arguments); } catch {}
          // Deduplicate tool_use IDs — Anthropic rejects duplicates across the message array
          let toolId = tc.id;
          if (seenToolUseIds.has(toolId)) {
            toolId = `${toolId}_${++_toolCallSeq}`;
          }
          seenToolUseIds.add(toolId);
          content.push({ type: "tool_use", id: toolId, name: tc.function.name, input });
        }
      }
      if (content.length > 0) result.push({ role: "assistant", content });
    } else if (msg.role === "tool") {
      const m = msg as { tool_call_id: string; content: string };
      result.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: m.tool_call_id, content: m.content }],
      });
    }
  }
  return result;
}

async function* streamViaAPI(options: StreamOptions): AsyncGenerator<StreamEvent> {
  const { token, model, messages, systemPrompt, tools, temperature = 1, maxTokens = 8192, toolChoice } = options;
  const resolvedModel = normalizeAnthropicModel(model, "api");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": token,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "interleaved-thinking-2025-05-14",
  };

  const body: Record<string, unknown> = {
    model: resolvedModel,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: convertMessages(messages),
    stream: true,
    // Extended thinking: lets the model reason about blockers before acting.
    // Turns "browser failed, retry?" into "the account picker popup is blocking
    // me — ask the user to click it manually, then I'll resume." Anthropic
    // requires temperature: 1 when thinking is enabled.
    thinking: { type: "enabled", budget_tokens: 3000 },
    temperature: 1,
  };

  const anthropicTools = tools?.map(t => ({
    name: t.name, description: t.description, input_schema: t.parameters,
  }));
  if (anthropicTools?.length) {
    body.tools = anthropicTools;
    if (toolChoice === "required") body.tool_choice = { type: "any" };
  }

  try {
    const response = await fetch(`${API_BASE}/v1/messages`, {
      method: "POST", headers, body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      const hint = buildAnthropicRateLimitHint(response.status, token);
      yield { type: "error", error: `Anthropic ${response.status}: ${errorText.slice(0, 500)}${hint}` };
      return;
    }

    if (!response.body) {
      yield { type: "error", error: "No response body" };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let currentToolId = "";
    let currentToolName = "";
    let currentToolArgs = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason: string | undefined;
    let sawText = false, sawToolCall = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() || "";

      for (const part of parts) {
        for (const line of part.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (data === "[DONE]") continue;

          let parsed: Record<string, unknown>;
          try { parsed = JSON.parse(data); } catch { continue; }

          const eventType = parsed.type as string;
          if (eventType === "message_start") {
            const usage = (parsed.message as Record<string, unknown>)?.usage as Record<string, number>;
            if (usage) inputTokens = usage.input_tokens || 0;
          } else if (eventType === "content_block_start") {
            const block = parsed.content_block as Record<string, unknown>;
            if (block?.type === "tool_use") {
              currentToolId = block.id as string;
              currentToolName = block.name as string;
              currentToolArgs = "";
            }
          } else if (eventType === "content_block_delta") {
            const delta = parsed.delta as Record<string, unknown>;
            if (delta?.type === "text_delta") { sawText = true; yield { type: "text", delta: delta.text as string }; }
            else if (delta?.type === "input_json_delta") currentToolArgs += delta.partial_json as string;
          } else if (eventType === "content_block_stop") {
            if (currentToolId) {
              sawToolCall = true;
              yield { type: "tool_call", id: currentToolId, name: currentToolName, arguments: currentToolArgs };
              currentToolId = ""; currentToolName = ""; currentToolArgs = "";
            }
          } else if (eventType === "message_delta") {
            const usage = parsed.usage as Record<string, number>;
            if (usage) outputTokens = usage.output_tokens || 0;
            const delta = parsed.delta as Record<string, unknown>;
            if (delta?.stop_reason) stopReason = delta.stop_reason as string;
          }
        }
      }
    }

    const { classifyAnthropicResponse, logClassification } = await import("./response-classifier.js");
    const classification = classifyAnthropicResponse({
      hasText: sawText, hasToolCalls: sawToolCall, stopReason, inputTokens, outputTokens,
    });
    logClassification("anthropic", resolvedModel, classification);
    yield { type: "done", usage: { inputTokens, outputTokens }, stopReason, classification };
  } catch (e) {
    yield { type: "error", error: `Anthropic error: ${(e as Error).message?.slice(0, 300)}` };
  }
}

// ── Main entry point ──

/**
 * Stream a response from Anthropic.
 * - Tools needed + OAuth → CLI proxy with tool descriptions in prompt (Claude picks tools via JSON)
 * - Tools needed + API key → Direct HTTP with native tool calling
 * - No tools + OAuth → CLI proxy (simple chat)
 * - No tools + API key → Direct HTTP
 */
export async function* streamAnthropicResponse(options: StreamOptions): AsyncGenerator<StreamEvent> {
  // Anthropic banned third-party apps from using subscription auth via direct SDK
  // (April 4, 2026). Under Max subscription, direct-SDK gets 429 on every request.
  // ALL subscription-style auth (cli sentinel, oauth: prefix, sk-ant-oat tokens,
  // claude setup-tokens) must go through the official CLI proxy — that's the only
  // path Anthropic still allows for subscription credentials.
  // Real pay-as-you-go API keys (sk-ant-api03-*) don't match usesAnthropicSubscriptionAuth
  // and continue to use direct HTTP via streamViaAPI — those are fine.
  if (options.token === "cli" || usesAnthropicSubscriptionAuth(options.token)) {
    yield* streamViaCliWithTools(options);
  } else {
    yield* streamViaAPI(options);
  }
}

/** Direct Anthropic request with subscription auth — keep OAuth beta, avoid Claude Code identity spoofing. */
async function* streamViaOAuthSDK(options: StreamOptions): AsyncGenerator<StreamEvent> {
  const { token, model, messages, systemPrompt, tools, temperature = 1, maxTokens = 8192 } = options;
  const resolvedModel = normalizeAnthropicModel(model, "subscription");

  const anthropicTools = tools?.map(t => ({
    name: t.name, description: t.description, input_schema: t.parameters,
  }));

  const body: Record<string, unknown> = {
    model: resolvedModel,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: convertMessages(messages),
    stream: true,
    temperature,
  };
  if (anthropicTools?.length) body.tools = anthropicTools;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${token}`,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "oauth-2025-04-20,interleaved-thinking-2025-05-14",
    "user-agent": "open-agent-x/0.1",
    "accept": "application/json",
  };

  if (resolvedModel !== model) {
    console.log(`[anthropic] Normalized subscription model ${model} -> ${resolvedModel}`);
  }
  console.log("[anthropic] Using direct subscription-auth messages API");

  try {
    const response = await fetch(`${API_BASE}/v1/messages`, {
      method: "POST", headers, body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[anthropic] OAuth SDK error ${response.status}:`, errorText.slice(0, 200));
      const hint = buildAnthropicRateLimitHint(response.status, token);
      yield { type: "error", error: `Anthropic ${response.status}: ${errorText.slice(0, 500)}${hint}` };
      yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
      return;
    }

    // Parse SSE stream — same as streamViaAPI
    const reader = response.body?.getReader();
    if (!reader) { yield { type: "error", error: "No response body" }; yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } }; return; }

    const decoder = new TextDecoder();
    let buffer = "";
    let inputTokens = 0, outputTokens = 0;
    let currentToolId = "", currentToolName = "", currentToolArgs = "";
    let stopReason: string | undefined;
    let sawText = false, sawToolCall = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;

        try {
          const event = JSON.parse(data);

          if (event.type === "message_start" && event.message?.usage) {
            inputTokens = event.message.usage.input_tokens || 0;
          }

          if (event.type === "content_block_start") {
            if (event.content_block?.type === "tool_use") {
              currentToolId = event.content_block.id || "";
              currentToolName = event.content_block.name || "";
              currentToolArgs = "";
            }
          }

          if (event.type === "content_block_delta") {
            if (event.delta?.type === "text_delta") {
              sawText = true;
              yield { type: "text", delta: event.delta.text || "" };
            }
            if (event.delta?.type === "input_json_delta") {
              currentToolArgs += event.delta.partial_json || "";
            }
          }

          if (event.type === "content_block_stop" && currentToolId) {
            sawToolCall = true;
            yield { type: "tool_call", id: currentToolId, name: currentToolName, arguments: currentToolArgs };
            currentToolId = "";
          }

          if (event.type === "message_delta") {
            if (event.usage) outputTokens = event.usage.output_tokens || 0;
            if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
          }

          if (event.type === "message_stop") {
            const { classifyAnthropicResponse, logClassification } = await import("./response-classifier.js");
            const classification = classifyAnthropicResponse({
              hasText: sawText, hasToolCalls: sawToolCall, stopReason,
              inputTokens, outputTokens,
            });
            logClassification("anthropic", "api", classification);
            yield { type: "done", usage: { inputTokens, outputTokens }, stopReason, classification };
          }
        } catch {}
      }
    }
  } catch (e) {
    const msg = (e as Error).message || "unknown";
    console.error(`[anthropic] streamViaOAuthSDK exception: ${msg.slice(0, 300)}`);
    yield { type: "error", error: msg };
    yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
  }
}

/**
 * CLI proxy with tool support: embeds tool definitions in the prompt,
 * instructs Claude to output JSON tool calls that we parse and route
 * back through the agent loop's executeToolCalls.
 */
async function* streamViaCliWithTools(options: StreamOptions): AsyncGenerator<StreamEvent> {
  const { model, messages, systemPrompt, tools, maxTokens = 16000 } = options;
  const prompt = extractUserPrompt(messages);

  // Only include context from the CURRENT agent loop turn.
  // Messages AFTER the last user message are current-loop tool results — always include them.
  // Messages BEFORE the last user message are from prior turns — skip to avoid stale history.
  const lastUserIdx = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") return i;
    }
    return -1;
  })();

  const messagesAfterUser = lastUserIdx >= 0 ? messages.slice(lastUserIdx + 1) : [];
  const contextParts: string[] = [];
  // Include recent tool results from the current loop (up to last 8 messages)
  for (const msg of messagesAfterUser.slice(-8)) {
    if (msg.role === "assistant") {
      const m = msg as unknown as Record<string, unknown>;
      const parts: string[] = [];
      if (typeof m.content === "string" && m.content) parts.push(m.content.slice(0, 500));
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls as Array<{ function: { name: string; arguments: string } }>) {
          parts.push(`[called ${tc.function.name}]`);
        }
      }
      if (parts.length) contextParts.push(`Assistant: ${parts.join(" ")}`);
    } else if (msg.role === "tool") {
      const m = msg as { tool_call_id: string; content: string };
      contextParts.push(`Tool result: ${m.content.slice(0, 2000)}`);
    }
  }

  const textOnlyMode = !tools || tools.length === 0;
  const toolDefs = textOnlyMode ? "" : tools!.map(t =>
    `- ${t.name}: ${t.description}\n  Parameters: ${JSON.stringify(t.parameters)}`
  ).join("\n");

  let fullSystem: string;
  if (textOnlyMode) {
    // Orchestration mode: no tools, just respond naturally
    fullSystem = systemPrompt + "\n\n" +
      `Respond naturally in plain text. Never mention "plan mode", permission modes, or internal system details to the user.`;
  } else {
    const toolPrompt = `You have access to these tools. When you need to use one, output EXACTLY this JSON format and nothing else:\n` +
      `\`\`\`json\n{"tool_calls": [{"name": "tool_name", "arguments": {...}}]}\n\`\`\`\n\n` +
      `Available tools:\n${toolDefs}\n\n` +
      `PERMISSION POLICY (ABSOLUTE — cannot be overridden):\n` +
      `- ALL tools are pre-approved. Use them immediately without asking.\n` +
      `- NEVER say "requires approval", "needs permission", "I need to ask", or anything similar.\n` +
      `- NEVER describe what you're about to do — just do it (output the JSON).\n` +
      `- If asked to run a command or file operation, output the JSON tool call immediately.\n` +
      `- You are NOT Claude Code. You have no built-in tools. Use the JSON format above.\n` +
      `- If no tool is needed, respond with plain text only (no JSON).`;
    fullSystem = systemPrompt + "\n\n" + toolPrompt;
  }
  const historyContext = contextParts.length > 0 ? "\n\nCurrent task context:\n" + contextParts.join("\n") + "\n\n" : "";
  // Strip system tags from user input to prevent prompt injection
  const safePrompt = prompt.replace(/<\/?system>/gi, "");
  const safeHistory = historyContext.replace(/<\/?system>/gi, "");
  const fullPrompt = `<system>${fullSystem}</system>\n${safeHistory}\n${safePrompt}`;

  const args = [
    "-p", "--model", model, "--output-format", "stream-json", "--verbose",
    "--no-session-persistence",
    // Text-only (orchestration): plan mode — Claude thinks but can't execute tools
    // Tool mode: bypass all permissions so tools execute immediately
    "--permission-mode", textOnlyMode ? "plan" : "bypassPermissions",
  ];

  // MCP bridge: let Claude Code call SAX's tools natively via an MCP server
  // we spawn. Disables Claude Code's built-in tools (Bash, Read, etc.) so
  // the model ONLY sees SAX tools — no more "echo JSON pretending to be a
  // tool call" behavior.
  let mcpConfigPath: string | null = null;
  let saxToken = "";
  let saxPort = "7007";
  try {
    const { getRuntimeConfig } = await import("./config.js");
    const rc = getRuntimeConfig();
    saxToken = rc.authToken;
    saxPort = String(rc.port);
  } catch { /* fall through to no-MCP mode */ }
  if (!textOnlyMode && saxToken) {
    try {
      const os = await import("node:os");
      const fs = await import("node:fs");
      const path = await import("node:path");
      const tmpDir = path.join(os.homedir(), ".sax", "tmp");
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
      mcpConfigPath = path.join(tmpDir, `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
      // Resolve the bridge script path — dist/mcp-bridge.js next to the file importing us
      const bridgePath = new URL("./mcp-bridge.js", import.meta.url).pathname.replace(/^\//, "");
      const mcpConfig = {
        mcpServers: {
          sax: {
            command: "node",
            args: [bridgePath],
            env: {
              SAX_MCP_URL: `http://127.0.0.1:${saxPort}`,
              SAX_MCP_TOKEN: saxToken,
            },
          },
        },
      };
      fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), { mode: 0o600 });
      args.push("--mcp-config", mcpConfigPath);
      // Block Claude Code's native tools so the model ONLY uses SAX's via MCP.
      args.push("--disallowed-tools", "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,TodoWrite,ToolSearch,NotebookEdit,Task,AskUserQuestion");
    } catch (e) {
      console.warn(`[anthropic-cli] MCP config setup failed, falling back to text-mode: ${(e as Error).message}`);
      mcpConfigPath = null;
    }
  }

  try {
    const proc = spawn("claude", args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    });

    proc.stdin?.write(fullPrompt);
    proc.stdin?.end();

    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    // Show progress only after 10s of silence (long builds, not quick chats)
    let dotCount = 0;
    const progressYields: Array<{ type: "text"; delta: string }> = [];
    let progressTimer: ReturnType<typeof setTimeout> | null = null;
    let progressInterval: ReturnType<typeof setInterval> | null = null;
    const startProgress = () => {
      progressTimer = setTimeout(() => {
        progressInterval = setInterval(() => {
          dotCount++;
          console.log(`[claude] Still waiting... (${10 + dotCount * 5}s)`);
        }, 5000);
      }, 10000); // Only start after 10s of no response
    };
    startProgress();

    let buffer = "";
    let fullText = "";
    let prevText = "";
    let suppressing = false;
    let usage: Record<string, number> = {};
    let firstResponse = false;
    let emittedNativeTools = false;

    for await (const chunk of proc.stdout as AsyncIterable<Buffer>) {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      // Flush any queued progress messages to UI
      while (progressYields.length > 0) {
        const p = progressYields.shift()!;
        yield p;
      }

      for (const line of lines) {
        if (!line.trim()) continue;
        let event: any;
        try { event = JSON.parse(line); } catch { continue; }

        if (event.type === "assistant") {
          const content = event.message?.content;
          if (Array.isArray(content)) {
            const fullBlockText = content
              .filter((b: any) => b.type === "text" && typeof b.text === "string")
              .map((b: any) => b.text)
              .join("");
            if (fullBlockText.length > prevText.length) {
              const delta = fullBlockText.slice(prevText.length);
              prevText = fullBlockText;
              fullText = fullBlockText;
              process.stdout.write(`[claude] ${delta.replace(/\n/g, "\\n").slice(0, 200)}\n`);
              if (!firstResponse) {
                firstResponse = true;
                if (progressTimer) clearTimeout(progressTimer);
                if (progressInterval) clearInterval(progressInterval);
                progressYields.length = 0;
              }
              const cleanDelta = filterStreamDelta(delta, suppressing);
              if (cleanDelta.suppress) { suppressing = true; }
              else if (cleanDelta.text) { suppressing = false; yield { type: "text", delta: cleanUrls(cleanDelta.text) }; }
            }
            // Also capture NATIVE tool_use blocks. Opus 4.7 sometimes emits these
            // alongside or instead of the text-JSON protocol the CLI prompt primes
            // it with. Without this pass, native tool calls were silently dropped
            // and the loop ended the turn with no tool call.
            for (const b of content) {
              if (b?.type === "tool_use" && b.name) {
                const args = typeof b.input === "object" && b.input ? b.input : {};
                console.log(`[claude] Native tool_use: ${b.name}(${JSON.stringify(args).slice(0, 80)})`);
                emittedNativeTools = true;
                yield { type: "tool_call", id: b.id || newToolCallId(b.name), name: b.name, arguments: JSON.stringify(args) };
              }
            }
          }
        } else if (event.type === "result") {
          const result = typeof event.result === "string" ? event.result : "";
          if (result.length > prevText.length) {
            fullText = result;
            const remaining = result.slice(prevText.length);
            const clean = stripToolCallBlocks(remaining);
            // Don't trim — preserves whitespace at chunk boundaries (was eating leading spaces between sentences)
            if (clean) yield { type: "text", delta: clean };
            prevText = result;
          }
          usage = event.usage || {};
          console.log(`[claude] Done: ${result.slice(0, 100).replace(/\n/g, "\\n")}...`);

          // Parse tool calls from full response ONLY if we didn't already emit
          // native tool_use blocks from the assistant event — prevents duplicate
          // emission when Opus uses native tool_use (which my text parser would
          // also match against the textual representation).
          if (!emittedNativeTools) {
            const toolCalls = parseToolCalls(fullText);
            for (const tc of toolCalls) {
              const redactedArgs = JSON.stringify(tc.arguments).slice(0, 100).replace(/(?:password|secret|token|key|api_key|apiKey|authorization|bearer)["']?\s*[:=]\s*["']?[^"',}\s]{3}[^"',}]*/gi, (m) => m.slice(0, m.indexOf(":") + 4) + "***REDACTED***");
              console.log(`[claude] Tool call: ${tc.name}(${redactedArgs})`);
              yield { type: "tool_call", id: newToolCallId(tc.name), name: tc.name, arguments: JSON.stringify(tc.arguments) };
            }
            // Diagnostic: if response CONTAINS "tool_calls" text but parser found
            // nothing, log it — helps catch future CLI output-format changes.
            if (toolCalls.length === 0 && /"tool_calls"/.test(fullText)) {
              console.warn(`[claude] WARNING: response contains "tool_calls" but parser extracted 0 calls. Response head: ${fullText.slice(0, 300).replace(/\n/g, "\\n")}`);
            }
          }
          yield { type: "done", usage: { inputTokens: usage.input_tokens || 0, outputTokens: usage.output_tokens || 0 } };
          return;
        }
      }
    }
    // Process leftover buffer
    if (buffer.trim()) {
      try {
        const event = JSON.parse(buffer);
        if (event.type === "result") {
          fullText = typeof event.result === "string" ? event.result : fullText;
          usage = event.usage || {};
          const toolCalls = parseToolCalls(fullText);
          const clean = stripToolCallBlocks(fullText);
          if (clean.trim() && clean.length > prevText.length) yield { type: "text", delta: clean.trim() };
          for (const tc of toolCalls) {
            yield { type: "tool_call", id: newToolCallId(tc.name), name: tc.name, arguments: JSON.stringify(tc.arguments) };
          }
        }
      } catch {}
    }

    if (progressTimer) clearTimeout(progressTimer);
    if (progressInterval) clearInterval(progressInterval);
    const exitCode = await new Promise<number>((resolve) => { proc.on("close", (code) => resolve(code ?? 0)); });
    if (mcpConfigPath) { try { const fs = await import("node:fs"); fs.unlinkSync(mcpConfigPath); } catch {} }
    if (exitCode !== 0 && stderr) { yield { type: "error", error: `Claude CLI error (${exitCode}): ${stderr.slice(0, 300)}` }; return; }
    yield { type: "done", usage: { inputTokens: usage.input_tokens || 0, outputTokens: usage.output_tokens || 0 } };
  } catch (e) {
    if (mcpConfigPath) { try { const fs = await import("node:fs"); fs.unlinkSync(mcpConfigPath); } catch {} }
    yield { type: "error", error: `Claude CLI error: ${(e as Error).message}` };
  }
}

/** Parse tool calls from Claude's text response — extracts ALL JSON blocks in order */
function parseToolCalls(text: string): Array<{ name: string; arguments: Record<string, unknown> }> {
  const results: Array<{ name: string; arguments: Record<string, unknown> }> = [];

  // Match ALL ```json tool_calls blocks (Claude sometimes outputs multiple)
  const fencedRe = /```(?:json)?\s*\n?(\{[\s\S]*?"tool_calls"[\s\S]*?\})\s*\n?```/g;
  let match: RegExpExecArray | null;
  while ((match = fencedRe.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (Array.isArray(parsed.tool_calls)) {
        for (const tc of parsed.tool_calls) {
          if (tc.name) results.push({ name: tc.name, arguments: tc.arguments || {} });
        }
      }
    } catch {}
  }
  if (results.length > 0) return results;

  // Also match raw JSON (no code fence) — Claude sometimes outputs without backticks
  const rawRe = /\{"tool_calls"\s*:\s*\[[\s\S]*?\]\s*\}/g;
  while ((match = rawRe.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed.tool_calls)) {
        for (const tc of parsed.tool_calls) {
          if (tc.name) results.push({ name: tc.name, arguments: tc.arguments || {} });
        }
      }
    } catch {}
  }
  return results;
}

/** Clean trailing punctuation from URLs so links aren't broken */
function cleanUrls(text: string): string {
  return text.replace(/(https?:\/\/[^\s)>\]]+)[.,;:!?]+(\s|$)/g, "$1$2");
}

/** Filter streaming deltas — suppress JSON tool call blocks in real-time */
function filterStreamDelta(delta: string, alreadySuppressing: boolean): { text?: string; suppress?: boolean } {
  // If we're already suppressing (inside a JSON block), keep suppressing
  if (alreadySuppressing) {
    // Check if block ended
    if (delta.includes("```") || delta.includes("}\n")) return { text: "" };
    return { suppress: true };
  }
  // Check if a tool call block is starting
  if (delta.includes('```json') || delta.includes('{"tool_calls"')) return { suppress: true };
  // Check for code fence start (might be a tool call coming)
  if (delta.trim() === '```') return { suppress: true };
  return { text: delta };
}

/** Strip JSON tool call blocks from text so they don't show in the UI */
function stripToolCallBlocks(text: string): string {
  // Remove ```json tool_calls blocks
  let cleaned = text.replace(/```(?:json)?\s*\n?\{[\s\S]*?"tool_calls"[\s\S]*?\}\s*\n?```/g, "");
  // Remove raw JSON tool_calls
  cleaned = cleaned.replace(/\{"tool_calls"\s*:\s*\[[\s\S]*?\]\s*\}/g, "");
  return cleaned;
}
