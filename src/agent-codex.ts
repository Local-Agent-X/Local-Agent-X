import type {
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions.js";
import type { ToolDefinition, AgentTurn, ServerEvent } from "./types.js";
import type { SecurityLayer } from "./security.js";
import type { ToolPolicy } from "./tool-policy.js";
import type { ThreatEngine } from "./threat-engine.js";
import type { RBACManager, Role } from "./rbac.js";
import { streamCodexResponse } from "./codex-client.js";
import { runCodexWs, type CodexTool as WsTool } from "./codex-ws.js";
import { checkSessionPolicy } from "./session-policy.js";
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

// ── Codex (ChatGPT subscription) Agent Loop — WebSocket ──

export async function runCodexAgent(
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
    onEvent,
    signal,
  } = options;

  const toolMap = new Map(tools.map((t) => [t.name, t]));

  const messages: ChatCompletionMessageParam[] = [
    ...history,
    { role: "user", content: userMessage },
  ];

  const codexTools: WsTool[] = tools.map((t) => ({
    type: "function" as const,
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));

  const turnMessages: ChatCompletionMessageParam[] = [];
  let totalInput = 0;
  let totalOutput = 0;

  // WebSocket disabled — Codex OAuth returns 500. Use HTTP.
  return runCodexAgentHttp(userMessage, history, options);

  // eslint-disable-next-line no-unreachable
  try {
    await runCodexWs({
      token: apiKey,
      model,
      messages,
      systemPrompt,
      tools: codexTools,
      maxIterations,

      events: {
        onText(delta) {
          onEvent?.({ type: "stream", delta });
        },
        onToolCall(id, name, args) {
          onEvent?.({ type: "tool_start", toolName: name, args: JSON.parse(args || "{}") });
        },
        onToolResult(id, name, result) {
          onEvent?.({
            type: "tool_end",
            toolName: name,
            result,
            allowed: true,
          });
          turnMessages.push({
            role: "assistant",
            content: null,
            tool_calls: [{
              id,
              type: "function",
              function: { name, arguments: "" },
            }],
          } as unknown as ChatCompletionMessageParam);
          turnMessages.push({
            role: "tool",
            tool_call_id: id,
            content: result,
          } as unknown as ChatCompletionMessageParam);
        },
        onDone(usage) {
          totalInput = usage.inputTokens;
          totalOutput = usage.outputTokens;
          onEvent?.({
            type: "done",
            usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput },
          });
        },
        onError(error) {
          console.log(`[agent] WS error (will fallback): ${error}`);
        },
      },

      async executeToolCall(name: string, argsJson: string): Promise<string> {
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(argsJson);
        } catch {
          args = {};
        }

        const pBlock = checkSessionPolicy(options.sessionId || "default", name);
        if (pBlock) return pBlock;

        const decision = security.evaluate({
          toolName: name,
          args,
          sessionId: options.sessionId || "default",
        });

        if (!decision.allowed) {
          return `BLOCKED by security: ${decision.reason}`;
        }

        if (options.toolPolicy) {
          const policyResult = options.toolPolicy.evaluate(name, args, options.sessionId);
          if (!policyResult.allowed) {
            return `BLOCKED by policy: ${policyResult.reason}`;
          }
        }

        const tool = toolMap.get(name);
        if (!tool) {
          return `Unknown tool: ${name}`;
        }

        try {
          const result = await tool.execute(args, signal);

          if (options.threatEngine) {
            const threat = options.threatEngine.evaluateToolResult(name, args, result.content, true);
            if (threat.blocked) {
              return `BLOCKED by threat engine: ${threat.reason}`;
            }
          }

          return result.content;
        } catch (e) {
          return `Tool error: ${(e as Error).message}`;
        }
      },
    });
  } catch (e) {
    console.log(`[agent] WS unavailable, using HTTP: ${(e as Error).message}`);
    return runCodexAgentHttp(userMessage, history, options);
  }

  return {
    messages: [{ role: "system", content: systemPrompt }, ...messages, ...turnMessages],
    usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput },
    stopReason: "end_turn",
  };
}

// ── HTTP fallback ──

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

    // Detect empty response (no text, no tool calls) — usually content moderation or model failure.
    // Without this guard, the loop exits with end_turn and chat.ts filters out the null-content
    // assistant message, leaving an orphaned user message in the session.
    if (toolCalls.length === 0 && !assistantContent.trim()) {
      const placeholder = "_(The model returned an empty response. This usually means OpenAI content moderation blocked the reply. Try rephrasing or starting a new chat.)_";
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
