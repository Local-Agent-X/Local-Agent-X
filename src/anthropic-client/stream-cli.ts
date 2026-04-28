import { spawn } from "child_process";
import { extractUserPrompt, newToolCallId } from "./request.js";
import { cleanUrls, filterStreamDelta, parseToolCalls, stripToolCallBlocks } from "./parse.js";
import { npmAugmentedEnv } from "./cli-path.js";
import type { StreamEvent, StreamOptions } from "./types.js";

import { createLogger } from "../logger.js";
const logger = createLogger("anthropic-client.stream-cli");

/**
 * CLI proxy with tool support: embeds tool definitions in the prompt,
 * instructs Claude to output JSON tool calls that we parse and route
 * back through the agent loop's executeToolCalls.
 */
export async function* streamViaCliWithTools(options: StreamOptions): AsyncGenerator<StreamEvent> {
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

  const textOnlyMode = !tools || tools.length === 0;
  // Peek whether MCP will be wired up — when it is, we skip the text-
  // serialized context entirely. Claude sees tool results natively via MCP
  // and doesn't need them re-serialized into its prompt; feeding them back
  // as "[called X] / Tool result: ..." text teaches it to echo that format
  // in its own reply (the garbled wall of EXTERNAL_UNTRUSTED_CONTENT the
  // user was seeing).
  const willUseMcp = !textOnlyMode && !!(await import("../config.js").then(m => m.getRuntimeConfig().authToken).catch(() => ""));

  const messagesAfterUser = lastUserIdx >= 0 ? messages.slice(lastUserIdx + 1) : [];
  const contextParts: string[] = [];
  if (!willUseMcp) {
    // Legacy text-JSON fallback path: keep the re-serialized context so the
    // model sees what tools have already run this turn.
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
  }
  const toolDefs = textOnlyMode ? "" : tools!.map(t =>
    `- ${t.name}: ${t.description}\n  Parameters: ${JSON.stringify(t.parameters)}`
  ).join("\n");

  let fullSystem: string;
  if (textOnlyMode) {
    // Orchestration mode: no tools, just respond naturally
    fullSystem = systemPrompt + "\n\n" +
      `Respond naturally in plain text. Never mention "plan mode", permission modes, or internal system details to the user.`;
  } else if (willUseMcp) {
    // MCP mode: tools come through MCP as mcp__lax__<name>. Claude calls them
    // natively. We just need to tell it not to echo tool metadata in replies.
    fullSystem = systemPrompt + "\n\n" +
      `You have Local Agent X's tools available via MCP (prefixed mcp__lax__). Call them directly when needed.\n\n` +
      `REPLY FORMAT (strict):\n` +
      `- After you finish, respond with a SHORT plain-English summary of what you did. 1-2 sentences max.\n` +
      `- NEVER paste raw tool output, JSON, or HTTP response bodies into your reply.\n` +
      `- NEVER echo [called X] / Tool result: / <<<EXTERNAL_UNTRUSTED_CONTENT>>> / <metadata> blocks — the UI renders tool activity as cards, the user doesn't need to see it twice.\n` +
      `- Good: "Switched the app to light mode." Bad: "[called http_request] Tool result: HTTP 200 OK ..."\n` +
      `- ALL tools are pre-approved. Just use them — never ask, never describe what you're about to do.`;
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
    // Emit stream_event frames (content_block_delta, text_delta, etc.) so we
    // can yield text token-by-token instead of waiting for each complete
    // content block. Without this, the UI sees nothing until the model is
    // fully done or hits a tool call.
    "--include-partial-messages",
    "--no-session-persistence",
    // Text-only (orchestration): plan mode — Claude thinks but can't execute tools
    // Tool mode: bypass all permissions so tools execute immediately
    "--permission-mode", textOnlyMode ? "plan" : "bypassPermissions",
  ];

  // MCP bridge: lets Claude CLI call Local Agent X tools natively via MCP.
  // The bridge subprocess is TypeScript, so we spawn it with tsx (not plain node).
  let mcpConfigPath: string | null = null;
  let saxToken = "";
  let saxPort = "7007";
  try {
    const { getRuntimeConfig } = await import("../config.js");
    const rc = getRuntimeConfig();
    saxToken = rc.authToken;
    saxPort = String(rc.port);
  } catch {}
  if (!textOnlyMode && saxToken) {
    try {
      const os = await import("node:os");
      const fs = await import("node:fs");
      const path = await import("node:path");
      const tmpDir = path.join(os.homedir(), ".lax", "tmp");
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
      mcpConfigPath = path.join(tmpDir, `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
      // Bridge is TypeScript — use tsx to run it. Fall back to compiled .js if available.
      const tsPath = path.resolve(path.join(import.meta.dirname || ".", "..", "mcp-bridge.ts"));
      const jsPath = path.resolve(path.join(import.meta.dirname || ".", "..", "mcp-bridge.js"));
      const bridgePath = fs.existsSync(jsPath) ? jsPath : tsPath;
      // Use tsx for .ts files, plain node for compiled .js
      const needsTsx = bridgePath.endsWith(".ts");
      const bridgeEnv: Record<string, string> = {
        LAX_MCP_URL: `http://127.0.0.1:${saxPort}`,
        LAX_MCP_TOKEN: saxToken,
      };
      if (options.sessionId) bridgeEnv.LAX_MCP_SESSION_ID = options.sessionId;
      // MCP server registered as "lax:" so Claude CLI namespaces tools as
      // mcp__lax__<name>. The matcher in providers/run-anthropic.ts strips
      // any mcp__X__ prefix, so existing handler code works unchanged. Old
      // sessions / cached prompts that still reference mcp__sax__ are a
      // one-turn confusion at most.
      const mcpConfig = {
        mcpServers: {
          lax: {
            command: "node",
            args: needsTsx ? ["--import=tsx", bridgePath] : [bridgePath],
            env: bridgeEnv,
          },
        },
      };
      fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), { mode: 0o600 });
      args.push("--mcp-config", mcpConfigPath);
      // Block Claude Code's native tools so the model ONLY uses Local Agent X's via MCP
      // Block ALL Claude Code native + deferred tools. Anything Claude knows
      // how to call but Local Agent X doesn't define must be denied here, or it leaks
      // through the policy as an unknown tool and gets default-denied with
      // a spurious BLOCKED result that poisons the next turn's context.
      args.push("--disallowed-tools", [
        // Core
        "Bash", "Read", "Write", "Edit", "Glob", "Grep",
        "WebFetch", "WebSearch", "TodoWrite", "ToolSearch",
        "NotebookEdit", "Task", "AskUserQuestion", "Skill",
        // Deferred / scheduling / plan-mode
        "CronCreate", "CronDelete", "CronList",
        "EnterPlanMode", "ExitPlanMode",
        "EnterWorktree", "ExitWorktree",
        "Monitor", "TaskOutput", "TaskStop",
        "ScheduleWakeup", "PushNotification", "RemoteTrigger",
      ].join(","));
    } catch (e) {
      logger.warn(`[anthropic-cli] MCP config setup failed, falling back to text-mode: ${(e as Error).message}`);
      mcpConfigPath = null;
    }
  }

  try {
    const proc = spawn("claude", args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
      env: npmAugmentedEnv(),
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
          logger.info(`[claude] Still waiting... (${10 + dotCount * 5}s)`);
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

        // With --include-partial-messages, Claude Code wraps API stream frames
        // in { type: "stream_event", event: { ... } }. Extract text_deltas so
        // they flow to the UI token-by-token instead of waiting for the full
        // content block to land.
        if (event.type === "stream_event" && event.event) {
          const inner = event.event;
          if (inner.type === "content_block_delta" && inner.delta?.type === "text_delta" && typeof inner.delta.text === "string") {
            if (!firstResponse) {
              firstResponse = true;
              if (progressTimer) clearTimeout(progressTimer);
              if (progressInterval) clearInterval(progressInterval);
              progressYields.length = 0;
            }
            // Track prevText so the later full-block assistant event doesn't
            // re-yield the same text we already emitted as deltas.
            prevText += inner.delta.text;
            fullText += inner.delta.text;
            const cleanDelta = filterStreamDelta(inner.delta.text, suppressing);
            if (cleanDelta.suppress) { suppressing = true; }
            else if (cleanDelta.text) { suppressing = false; yield { type: "text", delta: cleanUrls(cleanDelta.text) }; }
          }
          continue;
        }

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
            //
            // Skip `mcp__*` blocks — those are routed end-to-end through the MCP
            // bridge (which executes them via /api/mcp/call). If we ALSO yielded
            // them here, the agent loop would try to re-run them with the prefixed
            // name, fail the tool-map lookup, hit default-deny in the policy, and
            // feed a spurious BLOCKED result back into the model's context.
            for (const b of content) {
              if (b?.type === "tool_use" && b.name) {
                if (String(b.name).startsWith("mcp__")) {
                  logger.info(`[claude] MCP tool_use (handled via bridge): ${b.name}`);
                  // Signal to the agent loop that tool activity happened, so
                  // its "toolCalls.length === 0 → auto-route to build_app"
                  // fallback doesn't misfire. The tool already ran via MCP.
                  yield { type: "mcp_activity", name: b.name };
                  continue;
                }
                const args = typeof b.input === "object" && b.input ? b.input : {};
                logger.info(`[claude] Native tool_use: ${b.name}(${JSON.stringify(args).slice(0, 80)})`);
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
          logger.info(`[claude] Done: ${result.slice(0, 100).replace(/\n/g, "\\n")}...`);

          // Parse tool calls from full response ONLY if we didn't already emit
          // native tool_use blocks from the assistant event — prevents duplicate
          // emission when Opus uses native tool_use (which my text parser would
          // also match against the textual representation).
          if (!emittedNativeTools) {
            const toolCalls = parseToolCalls(fullText);
            for (const tc of toolCalls) {
              const redactedArgs = JSON.stringify(tc.arguments).slice(0, 100).replace(/(?:password|secret|token|key|api_key|apiKey|authorization|bearer)["']?\s*[:=]\s*["']?[^"',}\s]{3}[^"',}]*/gi, (m) => m.slice(0, m.indexOf(":") + 4) + "***REDACTED***");
              logger.info(`[claude] Tool call: ${tc.name}(${redactedArgs})`);
              yield { type: "tool_call", id: newToolCallId(tc.name), name: tc.name, arguments: JSON.stringify(tc.arguments) };
            }
            // Diagnostic: if response CONTAINS "tool_calls" text but parser found
            // nothing, log it — helps catch future CLI output-format changes.
            if (toolCalls.length === 0 && /"tool_calls"/.test(fullText)) {
              logger.warn(`[claude] WARNING: response contains "tool_calls" but parser extracted 0 calls. Response head: ${fullText.slice(0, 300).replace(/\n/g, "\\n")}`);
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
