/**
 * Anthropic client with dual strategy:
 * 1. Claude CLI proxy (for OAuth — uses `claude -p` which handles all auth natively)
 * 2. Raw HTTP fetch (for direct API keys — sk-ant-api03-*)
 */

import { spawn } from "child_process";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

interface StreamEvent {
  type: "text" | "tool_call" | "done" | "error";
  delta?: string;
  id?: string;
  name?: string;
  arguments?: string;
  usage?: { inputTokens: number; outputTokens: number };
  error?: string;
}

interface StreamOptions {
  token: string;
  model: string;
  messages: ChatCompletionMessageParam[];
  systemPrompt: string;
  tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  temperature?: number;
  maxTokens?: number;
}

const API_BASE = "https://api.anthropic.com";

function isOAuthToken(token: string): boolean {
  return token.includes("sk-ant-oat");
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
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

function convertMessages(messages: ChatCompletionMessageParam[]): AnthropicMessage[] {
  const result: AnthropicMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "system") continue;

    if (msg.role === "user") {
      result.push({
        role: "user",
        content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
      });
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
          content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
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
  const { token, model, messages, systemPrompt, tools, temperature = 1, maxTokens = 8192 } = options;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": token,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "interleaved-thinking-2025-05-14",
  };

  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: convertMessages(messages),
    stream: true,
    temperature,
  };

  const anthropicTools = tools?.map(t => ({
    name: t.name, description: t.description, input_schema: t.parameters,
  }));
  if (anthropicTools?.length) body.tools = anthropicTools;

  try {
    const response = await fetch(`${API_BASE}/v1/messages`, {
      method: "POST", headers, body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      yield { type: "error", error: `Anthropic ${response.status}: ${errorText.slice(0, 500)}` };
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
            if (delta?.type === "text_delta") yield { type: "text", delta: delta.text as string };
            else if (delta?.type === "input_json_delta") currentToolArgs += delta.partial_json as string;
          } else if (eventType === "content_block_stop") {
            if (currentToolId) {
              yield { type: "tool_call", id: currentToolId, name: currentToolName, arguments: currentToolArgs };
              currentToolId = ""; currentToolName = ""; currentToolArgs = "";
            }
          } else if (eventType === "message_delta") {
            const usage = parsed.usage as Record<string, number>;
            if (usage) outputTokens = usage.output_tokens || 0;
          }
        }
      }
    }

    yield { type: "done", usage: { inputTokens, outputTokens } };
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
  if (options.token === "cli") {
    // OAuth via "cli" sentinel — extract token, refresh if expired, use direct SDK
    try {
      const { loadAnthropicTokens, refreshAnthropicTokens } = await import("./auth-anthropic.js");
      let tokens = loadAnthropicTokens();
      if (tokens) {
        // Refresh if expired or within 5 min of expiry
        if (tokens.expiresAt && Date.now() >= tokens.expiresAt) {
          console.log("[anthropic] OAuth token expired — refreshing");
          try {
            tokens = await refreshAnthropicTokens(tokens);
          } catch (e) {
            console.warn("[anthropic] Token refresh failed:", (e as Error).message);
          }
        }
        if (tokens.accessToken) {
          yield* streamViaOAuthSDK({ ...options, token: tokens.accessToken });
          return;
        }
      }
    } catch {}
    // Fallback to CLI proxy if token extraction fails
    yield* streamViaCliWithTools(options);
  } else if (isOAuthToken(options.token)) {
    yield* streamViaOAuthSDK(options);
  } else {
    yield* streamViaAPI(options);
  }
}

/** Direct Anthropic SDK with OAuth — uses Claude Code identity headers (same approach as upstream) */
async function* streamViaOAuthSDK(options: StreamOptions): AsyncGenerator<StreamEvent> {
  const { token, model, messages, systemPrompt, tools, temperature = 1, maxTokens = 8192 } = options;

  // Map tool names to Claude Code format (bash → Bash, read → Read, etc.)
  const CC_TOOL_MAP: Record<string, string> = {
    bash: "Bash", read: "Read", write: "Write", edit: "Edit",
    grep: "Grep", glob: "Glob", web_fetch: "WebFetch", web_search: "WebSearch",
  };
  const toCC = (name: string) => CC_TOOL_MAP[name] || name;
  const fromCC = (name: string) => {
    for (const [k, v] of Object.entries(CC_TOOL_MAP)) { if (v === name) return k; }
    return name;
  };

  const anthropicTools = tools?.map(t => ({
    name: toCC(t.name), description: t.description, input_schema: t.parameters,
  }));

  const body: Record<string, unknown> = {
    model,
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
    "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14",
    "user-agent": "claude-cli/2.1.83",
    "x-app": "cli",
    "anthropic-dangerous-direct-browser-access": "true",
    "accept": "application/json",
  };

  console.log("[anthropic] Using direct OAuth SDK with Claude Code identity headers");

  try {
    const response = await fetch(`${API_BASE}/v1/messages`, {
      method: "POST", headers, body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[anthropic] OAuth SDK error ${response.status}:`, errorText.slice(0, 200));
      yield { type: "error", error: `Anthropic ${response.status}: ${errorText.slice(0, 500)}` };
      return;
    }

    // Parse SSE stream — same as streamViaAPI
    const reader = response.body?.getReader();
    if (!reader) { yield { type: "error", error: "No response body" }; return; }

    const decoder = new TextDecoder();
    let buffer = "";
    let inputTokens = 0, outputTokens = 0;
    let currentToolId = "", currentToolName = "", currentToolArgs = "";

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
              currentToolName = fromCC(event.content_block.name || "");
              currentToolArgs = "";
            }
          }

          if (event.type === "content_block_delta") {
            if (event.delta?.type === "text_delta") {
              yield { type: "text", delta: event.delta.text || "" };
            }
            if (event.delta?.type === "input_json_delta") {
              currentToolArgs += event.delta.partial_json || "";
            }
          }

          if (event.type === "content_block_stop" && currentToolId) {
            yield { type: "tool_call", id: currentToolId, name: currentToolName, arguments: currentToolArgs };
            currentToolId = "";
          }

          if (event.type === "message_delta" && event.usage) {
            outputTokens = event.usage.output_tokens || 0;
          }

          if (event.type === "message_stop") {
            yield { type: "done", usage: { inputTokens, outputTokens } };
          }
        } catch {}
      }
    }
  } catch (e) {
    yield { type: "error", error: (e as Error).message };
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

  // Build conversation context from history (tool results, previous messages)
  const contextParts: string[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.content) {
      contextParts.push(`Assistant: ${typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)}`);
    } else if (msg.role === "tool") {
      const m = msg as { tool_call_id: string; content: string };
      contextParts.push(`Tool result (${m.tool_call_id}): ${m.content}`);
    }
  }

  const toolDefs = tools!.map(t =>
    `- ${t.name}: ${t.description}\n  Parameters: ${JSON.stringify(t.parameters)}`
  ).join("\n");

  const toolPrompt = `You have access to these tools. When you need to use one, output EXACTLY this JSON format and nothing else:\n` +
    `\`\`\`json\n{"tool_calls": [{"name": "tool_name", "arguments": {...}}]}\n\`\`\`\n\n` +
    `Available tools:\n${toolDefs}\n\n` +
    `Rules:\n` +
    `- When the user asks you to run a command, call the bash tool immediately. Do not describe what would happen — call the tool.\n` +
    `- You have FULL PERMISSION to use all tools. Never ask for approval, never say "requires permission."\n` +
    `- You are NOT Claude Code. You do not have built-in Read/Write/Bash tools. You must output the JSON block above.\n` +
    `- If no tool is needed, respond with plain text (no JSON).`;

  const fullSystem = systemPrompt + "\n\n" + toolPrompt;
  const historyContext = contextParts.length > 0 ? "\n\nConversation so far:\n" + contextParts.join("\n") + "\n\n" : "";
  // Strip system tags from user input to prevent prompt injection
  const safePrompt = prompt.replace(/<\/?system>/gi, "");
  const safeHistory = historyContext.replace(/<\/?system>/gi, "");
  const fullPrompt = `<system>${fullSystem}</system>\n${safeHistory}\n${safePrompt}`;

  const args = [
    "-p", "--model", model, "--output-format", "stream-json", "--verbose",
    "--no-session-persistence",
  ];

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
            for (const block of content) {
              if (block.type === "text" && block.text.length > prevText.length) {
                const delta = block.text.slice(prevText.length);
                prevText = block.text;
                fullText = block.text;
                // Log all text to server console
                process.stdout.write(`[claude] ${delta.replace(/\n/g, "\\n").slice(0, 200)}\n`);
                // Stream to UI — but suppress JSON tool call blocks
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
            }
          }
        } else if (event.type === "result") {
          const result = typeof event.result === "string" ? event.result : "";
          if (result.length > prevText.length) {
            fullText = result;
            const remaining = result.slice(prevText.length);
            const clean = stripToolCallBlocks(remaining);
            if (clean.trim()) yield { type: "text", delta: clean.trim() };
          }
          usage = event.usage || {};
          console.log(`[claude] Done: ${result.slice(0, 100).replace(/\n/g, "\\n")}...`);

          // Parse and emit tool calls from full response
          const toolCalls = parseToolCalls(fullText);
          for (const tc of toolCalls) {
            const redactedArgs = JSON.stringify(tc.arguments).slice(0, 100).replace(/(?:password|secret|token|key|api_key|apiKey|authorization|bearer)["']?\s*[:=]\s*["']?[^"',}\s]{3}[^"',}]*/gi, (m) => m.slice(0, m.indexOf(":") + 4) + "***REDACTED***");
            console.log(`[claude] Tool call: ${tc.name}(${redactedArgs})`);
            yield { type: "tool_call", id: `call_${Date.now()}_${tc.name}`, name: tc.name, arguments: JSON.stringify(tc.arguments) };
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
            yield { type: "tool_call", id: `call_${Date.now()}_${tc.name}`, name: tc.name, arguments: JSON.stringify(tc.arguments) };
          }
        }
      } catch {}
    }

    if (progressTimer) clearTimeout(progressTimer);
    if (progressInterval) clearInterval(progressInterval);
    const exitCode = await new Promise<number>((resolve) => { proc.on("close", (code) => resolve(code ?? 0)); });
    if (exitCode !== 0 && stderr) { yield { type: "error", error: `Claude CLI error (${exitCode}): ${stderr.slice(0, 300)}` }; return; }
    yield { type: "done", usage: { inputTokens: usage.input_tokens || 0, outputTokens: usage.output_tokens || 0 } };
  } catch (e) {
    yield { type: "error", error: `Claude CLI error: ${(e as Error).message}` };
  }
}

/** Parse tool calls from Claude's text response (looks for JSON blocks) */
function parseToolCalls(text: string): Array<{ name: string; arguments: Record<string, unknown> }> {
  const results: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  // Match ```json blocks with tool_calls
  const jsonBlockMatch = text.match(/```(?:json)?\s*\n?(\{[\s\S]*?"tool_calls"[\s\S]*?\})\s*\n?```/);
  if (jsonBlockMatch) {
    try {
      const parsed = JSON.parse(jsonBlockMatch[1]);
      if (Array.isArray(parsed.tool_calls)) {
        for (const tc of parsed.tool_calls) {
          if (tc.name) results.push({ name: tc.name, arguments: tc.arguments || {} });
        }
      }
    } catch {}
    return results;
  }
  // Also match raw JSON (no code fence) — Claude sometimes outputs without backticks
  const rawMatch = text.match(/\{"tool_calls"\s*:\s*\[[\s\S]*?\]\s*\}/);
  if (rawMatch) {
    try {
      const parsed = JSON.parse(rawMatch[0]);
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
