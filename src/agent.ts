import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions.js";
import type { ToolDefinition, ToolResult, AgentTurn, ServerEvent } from "./types.js";
import { SecurityLayer } from "./security.js";
import { streamCodexResponse } from "./codex-client.js";
import { runCodexWs, type CodexTool as WsTool } from "./codex-ws.js";
import type { ToolPolicy } from "./tool-policy.js";
import type { ThreatEngine } from "./threat-engine.js";
import type { RBACManager, Role } from "./rbac.js";

interface AgentOptions {
  apiKey: string;
  model: string;
  baseURL?: string;
  provider: "xai" | "openai" | "codex";
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
  onEvent?: (event: ServerEvent) => void;
  signal?: AbortSignal;
}

function toolsToOpenAI(tools: ToolDefinition[]): ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

async function executeToolCalls(
  toolCalls: Array<{ id: string; name: string; arguments: string }>,
  toolMap: Map<string, ToolDefinition>,
  security: SecurityLayer,
  toolPolicy?: ToolPolicy,
  threatEngine?: ThreatEngine,
  rbac?: RBACManager,
  callerRole?: Role,
  sessionId?: string,
  onEvent?: (event: ServerEvent) => void,
  signal?: AbortSignal
): Promise<ChatCompletionMessageParam[]> {
  const results: ChatCompletionMessageParam[] = [];

  for (const tc of toolCalls) {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(tc.arguments);
    } catch {
      args = {};
    }

    onEvent?.({ type: "tool_start", toolName: tc.name, args });

    // Layer 1: SecurityLayer (SSRF, shell, file access, path traversal)
    const secDecision = security.evaluate({
      toolName: tc.name,
      args,
      sessionId: sessionId || "default",
    });

    // Layer 2: RBAC tool permission (role-based tool access)
    let rbacBlocked = false;
    let rbacReason = "";
    if (secDecision.allowed && rbac && callerRole) {
      const rbacDecision = rbac.checkTool(callerRole, tc.name);
      if (!rbacDecision.allowed) {
        rbacBlocked = true;
        rbacReason = rbacDecision.reason;
      }
    }

    // Layer 3: ToolPolicy (configurable allow/deny rules, rate limits, host constraints)
    let policyBlocked = false;
    let policyReason = "";
    if (secDecision.allowed && !rbacBlocked && toolPolicy) {
      const policyDecision = toolPolicy.evaluate(tc.name, args, sessionId || "default");
      if (!policyDecision.allowed) {
        policyBlocked = true;
        policyReason = policyDecision.reason;
      }
    }

    const allowed = secDecision.allowed && !rbacBlocked && !policyBlocked;
    let result: ToolResult;

    if (!secDecision.allowed) {
      result = { content: `BLOCKED by security: ${secDecision.reason}`, isError: true };
    } else if (rbacBlocked) {
      result = { content: `BLOCKED by RBAC: ${rbacReason}`, isError: true };
    } else if (policyBlocked) {
      result = { content: `BLOCKED by policy: ${policyReason}`, isError: true };
    } else {
      const tool = toolMap.get(tc.name);
      if (!tool) {
        result = { content: `Unknown tool: ${tc.name}`, isError: true };
      } else {
        try {
          result = await tool.execute(args, signal);
        } catch (e) {
          result = { content: `Tool error: ${(e as Error).message}`, isError: true };
        }
      }
    }

    // Layer 3: ThreatEngine post-execution analysis
    // (exfiltration detection, data classification, threat scoring, audit)
    if (threatEngine) {
      const threat = threatEngine.evaluateToolResult(tc.name, args, result.content, allowed);
      if (threat.blocked) {
        result = { content: `BLOCKED by threat engine: ${threat.reason}`, isError: true };
      }
      // If session is in restricted mode (high threat score), block external tools
      if (threatEngine.isRestricted() && ["http_request", "web_fetch", "browser"].includes(tc.name)) {
        result = {
          content: `BLOCKED: Session threat level is ${threat.threatLevel} (score: ${threat.threatScore}). External tool calls are restricted. Resolve security concerns first.`,
          isError: true,
        };
      }
    }

    onEvent?.({
      type: "tool_end",
      toolName: tc.name,
      result: result.content,
      allowed,
    });

    results.push({
      role: "tool",
      tool_call_id: tc.id,
      content: result.content,
    });
  }

  return results;
}

// ── Codex (ChatGPT subscription) Agent Loop ──

async function runCodexAgent(
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

  // Track all messages generated during this turn
  const turnMessages: ChatCompletionMessageParam[] = [];
  let totalInput = 0;
  let totalOutput = 0;

  try {
    // Use WebSocket for continuous tool chaining — the model keeps working
    // without waiting for the user to say "continue"
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
          // Track tool call + result in messages for session persistence
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
          // Don't surface WS errors to user — fallback to HTTP handles it
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

        // Security check
        const decision = security.evaluate({
          toolName: name,
          args,
          sessionId: options.sessionId || "default",
        });

        if (!decision.allowed) {
          return `BLOCKED by security: ${decision.reason}`;
        }

        // Policy check
        if (options.toolPolicy) {
          const policyResult = options.toolPolicy.evaluate(name, args, options.sessionId);
          if (!policyResult.allowed) {
            return `BLOCKED by policy: ${policyResult.reason}`;
          }
        }

        // Execute
        const tool = toolMap.get(name);
        if (!tool) {
          return `Unknown tool: ${name}`;
        }

        try {
          const result = await tool.execute(args, signal);

          // Threat engine check
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
    // WebSocket failed — fall back to HTTP streaming (expected for Codex OAuth)
    console.log(`[agent] WS unavailable, using HTTP: ${(e as Error).message}`);
    return runCodexAgentHttp(userMessage, history, options);
  }

  return {
    messages: [{ role: "system", content: systemPrompt }, ...messages, ...turnMessages],
    usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput },
    stopReason: "end_turn",
  };
}

// ── HTTP fallback (original implementation) ──

async function runCodexAgentHttp(
  userMessage: string,
  history: ChatCompletionMessageParam[],
  options: AgentOptions
): Promise<AgentTurn> {
  const { apiKey, model, systemPrompt, tools, security, maxIterations = 25, onEvent, signal } = options;
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const messages: ChatCompletionMessageParam[] = [...history, { role: "user", content: userMessage }];
  let totalInput = 0, totalOutput = 0;
  let previousResponseId: string | undefined;
  const codexTools = tools.map((t) => ({ type: "function" as const, name: t.name, description: t.description, parameters: t.parameters }));

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (signal?.aborted) return { messages: [{ role: "system", content: systemPrompt }, ...messages], usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput }, stopReason: "abort" };

    let assistantContent = "";
    const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];

    // Use previous_response_id for incremental turns (only send new tool results)
    const streamMessages = previousResponseId
      ? messages.slice(-toolCalls.length * 2) // Only new tool results
      : messages;

    // Force tool use on iterations 1+ (after the model already responded with text)
    // This prevents the "I'll do it" → wait → "ok do it" loop
    // First iteration: auto (model can respond with text or tools)
    // Iterations 1-3: required (force tool use if there were tool calls)
    // Iterations 4+: auto (let model finish with text)
    const forceToolUse = iteration > 0 && iteration < 4;

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

    const assistantMsg: ChatCompletionMessageParam = { role: "assistant", content: assistantContent || null };
    if (toolCalls.length > 0) { (assistantMsg as Record<string, unknown>).tool_calls = toolCalls.map((tc) => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: tc.arguments } })); }
    messages.push(assistantMsg);

    if (toolCalls.length === 0) {
      onEvent?.({ type: "done", usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput } });
      return { messages: [{ role: "system", content: systemPrompt }, ...messages], usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput }, stopReason: "end_turn" };
    }

    const toolResults = await executeToolCalls(toolCalls, toolMap, security, options.toolPolicy, options.threatEngine, options.rbac, options.callerRole, options.sessionId, onEvent, signal);
    messages.push(...toolResults);
  }

  return { messages: [{ role: "system", content: systemPrompt }, ...messages], usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput }, stopReason: "max_iterations" };
}

// ── Standard (xAI/OpenAI API) Agent Loop ──

async function runStandardAgent(
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

  const baseURL = options.baseURL || (options.provider === "xai" ? "https://api.x.ai/v1" : "https://api.openai.com/v1");
  const client = new OpenAI({ apiKey, baseURL });
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: userMessage },
  ];

  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let stdLastToolKey = "";
  let stdSameToolCount = 0;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (signal?.aborted) {
      return {
        messages,
        usage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens, totalTokens: totalPromptTokens + totalCompletionTokens },
        stopReason: "abort",
      };
    }

    const stream = await client.chat.completions.create({
      model,
      messages,
      tools: toolsToOpenAI(tools),
      temperature,
      stream: true,
    });

    let assistantContent = "";
    const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];

    for await (const chunk of stream) {
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

    const assistantMsg: ChatCompletionMessageParam = {
      role: "assistant",
      content: assistantContent || null,
    };
    if (toolCalls.length > 0) {
      (assistantMsg as Record<string, unknown>).tool_calls = toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.arguments },
      }));
    }
    messages.push(assistantMsg);

    if (toolCalls.length === 0) {
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

    // Detect tool call loops
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

    const toolResults = await executeToolCalls(toolCalls, toolMap, security, options.toolPolicy, options.threatEngine, options.rbac, options.callerRole, options.sessionId, onEvent, signal);
    messages.push(...toolResults);
  }

  return {
    messages,
    usage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens, totalTokens: totalPromptTokens + totalCompletionTokens },
    stopReason: "max_iterations",
  };
}

// ── Main Entry Point ──

export async function runAgent(
  userMessage: string,
  history: ChatCompletionMessageParam[],
  options: AgentOptions
): Promise<AgentTurn> {
  if (options.provider === "codex") {
    return runCodexAgent(userMessage, history, options);
  }
  return runStandardAgent(userMessage, history, options);
}
