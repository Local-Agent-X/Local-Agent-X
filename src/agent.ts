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
import { compactIfNeeded, getContextStatus, type ContextStatus } from "./context-manager.js";
import { streamAnthropicResponse } from "./anthropic-client.js";
import { checkSessionPolicy } from "./session-policy.js";
import { ariEvaluate, isAriActive } from "./ari-kernel.js";
import { recordSensitiveRead, checkEgressTaint, isSensitivePath } from "./data-lineage.js";

interface ImageAttachment {
  url: string;       // server URL like /uploads/abc.png
  filePath?: string;  // absolute path on disk
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

// ── Approval context: enrich tool events with risk info ──
function getRiskLevel(toolName: string, args: Record<string, unknown>): "low" | "medium" | "high" {
  if (toolName === "bash") return "high";
  if (toolName === "write" || toolName === "edit") {
    const path = String(args.path || "");
    if (/src\//.test(path)) return "high"; // Editing source code
    return "medium";
  }
  if (toolName === "browser") {
    const action = String(args.action || "");
    if (action === "evaluate") return "high";
    if (action === "navigate" || action === "new_tab") return "medium";
    return "low";
  }
  if (toolName === "http_request" || toolName === "web_fetch") return "medium";
  if (toolName === "read") return "low";
  return "low";
}

function buildApprovalContext(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case "bash":
      return `Shell: ${String(args.command || "").slice(0, 200)}`;
    case "write":
      return `Write ${String(args.path || "")} (${String(args.content || "").length} chars)`;
    case "edit":
      return `Edit ${String(args.path || "")}`;
    case "read":
      return `Read ${String(args.path || "")}`;
    case "browser": {
      const a = String(args.action || "");
      if (a === "navigate" || a === "new_tab") return `Browser → ${args.url || ""}`;
      if (a === "evaluate") return `Browser JS: ${String(args.script || "").slice(0, 100)}`;
      return `Browser: ${a}`;
    }
    case "http_request":
      return `${args.method || "GET"} ${String(args.url || "").slice(0, 100)}`;
    default:
      return `${toolName} ${JSON.stringify(args).slice(0, 100)}`;
  }
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

    // Build rich approval context for risky tool calls
    const riskLevel = getRiskLevel(tc.name, args);
    const approvalContext = buildApprovalContext(tc.name, args);
    const requiresApproval = riskLevel === "high";
    onEvent?.({ type: "tool_start", toolName: tc.name, args, riskLevel, context: approvalContext, requiresApproval });

    // Layer -1: AriKernel (taint tracking, behavioral rules, quarantine)
    const isInternalTool = tc.name.startsWith("agent_") || tc.name.startsWith("swarm_") ||
      tc.name.startsWith("mission_") || tc.name.startsWith("cron_") ||
      ["delegate", "generate_image", "generate_video", "camera_capture", "screen_capture", "ocr",
       "memory_search", "memory_save", "playbook_list", "playbook_get"].includes(tc.name);
    if (isAriActive()) {
      const actionMap: Record<string, string> = { read: "read", write: "write", edit: "write", bash: "exec" };
      const ariResult = await ariEvaluate(tc.name, actionMap[tc.name] || "exec", args);
      if (!ariResult.allowed) {
        if (isInternalTool) {
          // Internal tools: ARI logs the concern but doesn't block — these are our own code
          console.warn(`[ari] Internal tool ${tc.name} flagged but allowed: ${ariResult.reason}`);
        } else {
          const result = ariResult.reason;
          onEvent?.({ type: "tool_end", toolName: tc.name, result, allowed: false });
          results.push({ role: "tool", tool_call_id: tc.id, content: result } as any);
          continue;
        }
      }
    }

    // Layer 0: Session policy (per-session overrides — high-security, read-only, etc.)
    const policyBlock = checkSessionPolicy(sessionId || "default", tc.name);
    if (policyBlock) {
      onEvent?.({ type: "tool_end", toolName: tc.name, result: policyBlock, allowed: false });
      results.push({ role: "tool", tool_call_id: tc.id, content: policyBlock } as any);
      continue;
    }

    // Layer 1: SecurityLayer (SSRF, shell, file access, path traversal)
    const secDecision = security.evaluate({
      toolName: tc.name,
      args,
      sessionId: sessionId || "default",
    });

    // Layer 2: RBAC tool permission (ALWAYS runs — not gated by SecurityLayer)
    // This prevents role escalation: user role can't access operator-only tools
    // even if SecurityLayer would allow the operation itself
    let rbacBlocked = false;
    let rbacReason = "";
    if (rbac && callerRole) {
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
      // Data lineage: block egress if session has tainted data
      const egressTools = ["http_request", "web_fetch"];
      if (egressTools.includes(tc.name)) {
        const egressCheck = checkEgressTaint(sessionId || "default");
        if (egressCheck.blocked) {
          result = { content: `BLOCKED by data lineage: ${egressCheck.reason}`, isError: true };
          onEvent?.({ type: "tool_end", toolName: tc.name, result: result.content, allowed: false });
          results.push({ role: "tool", tool_call_id: tc.id, content: result.content } as any);
          continue;
        }
      }

      const tool = toolMap.get(tc.name);
      if (!tool) {
        result = { content: `Unknown tool: ${tc.name}`, isError: true };
      } else {
        try {
          result = await tool.execute(args, signal);
          // Data lineage: record sensitive reads for taint tracking
          if (tc.name === "read" && isSensitivePath(String(args.path || ""))) {
            recordSensitiveRead(sessionId || "default", "sensitive_file", String(args.path));
          }
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
      // Exception: browser interacting with our own app (localhost:4800) is always safe
      if (threatEngine.isRestricted() && ["http_request", "web_fetch", "browser"].includes(tc.name)) {
        let isOwnApp = false;
        if (tc.name === "browser") {
          const urlArg = String(args.url || "");
          // Navigating to our own app
          const appPort = process.env.SAX_PORT || "4800";
          if (new RegExp(`^https?://(127\\.0\\.0\\.1|localhost):${appPort}`, "i").test(urlArg)) {
            isOwnApp = true;
          } else if (!urlArg) {
            // Non-navigation action (click/fill/etc) — check if currently on our app
            try {
              const { getBrowserManager } = await import("./browser.js");
              isOwnApp = getBrowserManager(sessionId || "default").isOnOwnApp();
            } catch {}
          }
        }
        if (!isOwnApp) {
          result = {
            content: `BLOCKED: Session threat level is ${threat.threatLevel} (score: ${threat.threatScore}). External tool calls are restricted. Resolve security concerns first.`,
            isError: true,
          };
        }
      }
    }

    onEvent?.({
      type: "tool_end",
      toolName: tc.name,
      result: result.content,
      allowed,
    });

    // Check if tool returned an image for vision analysis
    const imageData = (result as any)._image;
    if (imageData) {
      // Add tool result with brief text
      results.push({
        role: "tool",
        tool_call_id: tc.id,
        content: `Image loaded: ${imageData.path}\nQuestion: ${imageData.question}`,
      });
      // Add vision message so the model can SEE the image on next turn
      results.push({
        role: "user",
        content: [
          { type: "text", text: `[Image from ${imageData.path}] ${imageData.question}` },
          { type: "image_url", image_url: { url: `data:${imageData.mime};base64,${imageData.b64}`, detail: "auto" } },
        ],
      } as any);
    } else {
      results.push({
        role: "tool",
        tool_call_id: tc.id,
        content: result.content,
      });
    }
  }

  return results;
}

// ── Context compaction helper ──

function checkAndCompact(
  messages: ChatCompletionMessageParam[],
  model: string,
  onEvent?: (event: ServerEvent) => void,
  force: boolean = false
): ChatCompletionMessageParam[] {
  const result = compactIfNeeded(messages, model, force);

  // Emit context status to UI
  onEvent?.({
    type: "context_status",
    percentage: result.status.percentage,
    level: result.status.level,
    usedTokens: result.status.usedTokens,
    maxTokens: result.status.maxTokens,
    compacted: result.compacted,
  });

  return result.messages;
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

  // WebSocket disabled — Codex OAuth returns 500. Use HTTP.
  return runCodexAgentHttp(userMessage, history, options);

  // eslint-disable-next-line no-unreachable
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

        // Session policy check
        const pBlock = checkSessionPolicy(options.sessionId || "default", name);
        if (pBlock) return pBlock;

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

  // Build user message with vision content if images attached
  let userContent: any = userMessage;
  if (options.images && options.images.length > 0) {
    const parts: any[] = [{ type: "text", text: userMessage }];
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

  let messages: ChatCompletionMessageParam[] = [...history, { role: "user", content: userContent }];
  let totalInput = 0, totalOutput = 0;
  let previousResponseId: string | undefined;
  const codexTools = tools.map((t) => ({ type: "function" as const, name: t.name, description: t.description, parameters: t.parameters }));

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (signal?.aborted) return { messages: [{ role: "system", content: systemPrompt }, ...messages], usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput }, stopReason: "abort" };

    // Auto-compact if context is getting full (preserves task state + recent messages)
    messages = checkAndCompact(messages, model, onEvent);

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
      onEvent?.({ type: "stream", delta: `\n\nError: ${errMsg}` });
      break;
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
  }

  return { messages: [{ role: "system", content: systemPrompt }, ...messages], usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput }, stopReason: "max_iterations" };
}

// Cache of local models that don't support tool calling (avoids repeated 400 errors)
const _localNoToolModels = new Set<string>();

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

  const providerURLs: Record<string, string> = {
    local: "http://127.0.0.1:11434/v1",
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
      // Read file and convert to base64 data URL for the vision API
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
    userContent = parts as any;
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

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    // Auto-compact if context is getting full
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
        // If model doesn't support tools, remember and retry without them
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
      onEvent?.({ type: "stream", delta: `\n\nError: ${errMsg}` });
      break;
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

// ── Anthropic (Claude) Agent Loop ──

async function runAnthropicAgent(
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
        onEvent?.({ type: "error", message: event.error || "Anthropic error" });
      }
    }

    // Build assistant message
    const assistantMsg: ChatCompletionMessageParam = { role: "assistant", content: assistantContent || null };
    if (toolCalls.length > 0) {
      (assistantMsg as unknown as Record<string, unknown>).tool_calls = toolCalls.map(tc => ({
        id: tc.id, type: "function", function: { name: tc.name, arguments: tc.arguments },
      }));
    }
    messages.push(assistantMsg);

    // Intercept: if Claude tried to write files directly instead of calling build_app,
    // detect it and auto-route to build_app
    if (toolCalls.length === 0 && detectBuildIntent(assistantContent, userMessage)) {
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
      onEvent?.({ type: "done", usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput } });
      return { messages: [{ role: "system", content: systemPrompt }, ...messages], usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput }, stopReason: "end_turn" };
    }

    const toolResults = await executeToolCalls(toolCalls, toolMap, security, options.toolPolicy, options.threatEngine, options.rbac, options.callerRole, options.sessionId, onEvent, signal);
    messages.push(...toolResults);
  }

  return { messages: [{ role: "system", content: systemPrompt }, ...messages], usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput }, stopReason: "max_iterations" };
}

/** Detect if Claude tried to build/write an app instead of calling build_app */
function detectBuildIntent(response: string, userMessage: string): boolean {
  const buildKeywords = /\b(build|create|make|write|upgrade|update|improve|redesign|level.?up)\b.*\b(app|website|page|game|project|todo|site)\b/i;
  const claudeCodeSignals = /permission|allow|click allow|approve|write.*file|I'll write|I'll create the file|mkdir|workspace.apps/i;
  if (buildKeywords.test(userMessage) && claudeCodeSignals.test(response)) return true;
  if (/I'll (write|create|drop|save) (the |these |all )?files/i.test(response)) return true;
  return false;
}

/** Extract app name from conversation */
function extractAppName(response: string, userMessage: string): string {
  // Check response for workspace/apps/ path
  const wsMatch = response.match(/workspace\/apps\/([a-zA-Z0-9_-]+)/);
  if (wsMatch) return wsMatch[1];
  // Check if an app with a similar name exists in workspace/apps/
  try {
    const { readdirSync, existsSync } = require("fs");
    const { resolve } = require("path");
    const appsDir = resolve("workspace", "apps");
    if (existsSync(appsDir)) {
      const apps = readdirSync(appsDir) as string[];
      const msg = userMessage.toLowerCase();
      for (const app of apps) {
        // Match if user mentions the app name (e.g. "todo" matches "todo-app")
        const appWords = app.replace(/-/g, " ").toLowerCase();
        if (msg.includes(appWords) || msg.includes(app) || appWords.split(" ").some((w: string) => w.length > 3 && msg.includes(w))) {
          return app;
        }
      }
    }
  } catch {}
  // Fallback: extract from user message
  const m = userMessage.match(/(?:the\s+)?([a-z][a-z0-9]+(?:[- ][a-z0-9]+)*)\s+app/i);
  if (m) return m[1].trim().toLowerCase().replace(/\s+/g, "-");
  return "my-app";
}

/** Build a prompt for build_app from the conversation context */
function extractBuildPrompt(response: string, userMessage: string): string {
  const cleanResponse = response.replace(/permission|allow|click allow|approve|Claude Code/gi, "").slice(0, 1000);
  return `User request: ${userMessage}\n\nDetails from conversation: ${cleanResponse}`;
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
  if (options.provider === "anthropic") {
    return runAnthropicAgent(userMessage, history, options);
  }
  return runStandardAgent(userMessage, history, options);
}
