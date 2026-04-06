import type {
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions.js";
import type { ToolDefinition, AgentTurn, ServerEvent } from "./types.js";
import type { SecurityLayer } from "./security.js";
import type { ToolPolicy } from "./tool-policy.js";
import type { ThreatEngine } from "./threat-engine.js";
import type { RBACManager, Role } from "./rbac.js";
import { runCodexAgent } from "./agent-codex.js";
import { runStandardAgent, runAnthropicAgent } from "./agent-providers.js";

export interface ImageAttachment {
  url: string;
  filePath?: string;
  name: string;
}

export interface AgentOptions {
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
  /** OpenAI/Codex key used for tool execution when Anthropic is orchestrating */
  codexApiKey?: string;
}

// ── Main Entry Point (with query pipeline) ──

export async function runAgent(
  userMessage: string,
  history: ChatCompletionMessageParam[],
  options: AgentOptions
): Promise<AgentTurn> {
  // Run pre-middleware (model routing, context enrichment)
  let pipelineCtx: import("./query-pipeline.js").QueryContext | null = null;
  try {
    const { getDefaultPipeline } = await import("./query-pipeline.js");
    const pipeline = getDefaultPipeline();
    pipelineCtx = await pipeline.runPre({
      userMessage, history, systemPrompt: options.systemPrompt,
      model: options.model, provider: options.provider,
      temperature: options.temperature || 0.7,
      sessionId: options.sessionId || "default", meta: {},
    });
  } catch {}

  // Execute the agent
  let turn: AgentTurn;
  if (options.provider === "anthropic") {
    console.log(`[orchestrator] codexApiKey present: ${!!options.codexApiKey} (len: ${options.codexApiKey?.length ?? 0})`);
  }
  if (options.provider === "codex") {
    turn = await runCodexAgent(userMessage, history, options);
  } else if (options.provider === "anthropic" && options.codexApiKey) {
    turn = await runAnthropicOrchestratorAgent(userMessage, history, options);
  } else if (options.provider === "anthropic") {
    turn = await runAnthropicAgent(userMessage, history, options);
  } else {
    turn = await runStandardAgent(userMessage, history, options);
  }

  // Run post-middleware (cost tracking, quality scoring, logging)
  if (pipelineCtx) {
    try {
      const { getDefaultPipeline } = await import("./query-pipeline.js");
      const pipeline = getDefaultPipeline();
      const result = await pipeline.runPost({ turn, context: pipelineCtx });
      turn = result.turn;
    } catch {}
  }

  return turn;
}

// ── Anthropic Orchestrator + Codex Executor ──
// Anthropic reasons in text (no tools, no CLI proxy issues).
// If action is needed, Codex takes over with native tool calling.

async function runAnthropicOrchestratorAgent(
  userMessage: string,
  history: ChatCompletionMessageParam[],
  options: AgentOptions
): Promise<AgentTurn> {
  const { streamAnthropicResponse } = await import("./anthropic-client.js");
  const { onEvent, signal } = options;

  // Phase 1: Anthropic reasons — text only, no tools, no CLI proxy fallback
  let anthropicText = "";
  let totalInput = 0, totalOutput = 0;
  let anthropicUnavailable = false;
  let anthropicError = "";

  console.log(`[orchestrator] Phase 1: Anthropic ${options.model} (text-only, no CLI fallback)`);

  for await (const event of streamAnthropicResponse({
    token: options.apiKey,
    model: options.model,
    messages: [...history, { role: "user", content: userMessage }],
    systemPrompt: options.systemPrompt,
    tools: [], // No tools — CLI runs in --permission-mode plan (thinks but can't execute)
    temperature: options.temperature,
  })) {
    if (signal?.aborted) break;
    if (event.type === "text") {
      anthropicText += event.delta;
      onEvent?.({ type: "stream", delta: event.delta || "" });
    } else if (event.type === "done") {
      totalInput += event.usage?.inputTokens || 0;
      totalOutput += event.usage?.outputTokens || 0;
      console.log(`[orchestrator] Anthropic done: ${totalInput}in/${totalOutput}out tokens, text length: ${anthropicText.length}`);
    } else if (event.type === "error") {
      anthropicError = event.error || "unknown";
      console.log(`[orchestrator] Anthropic error: "${anthropicError}"`);
      if (event.error?.includes("429") || event.error?.includes("unavailable")) {
        anthropicUnavailable = true;
      } else {
        onEvent?.({ type: "error", message: event.error || "Anthropic error" });
      }
    }
  }

  // If Anthropic was rate-limited or unavailable, route everything to Codex
  if (anthropicUnavailable || !anthropicText.trim()) {
    const reason = anthropicUnavailable ? anthropicError || "rate-limited" : "empty response";
    console.log(`[orchestrator] Anthropic failed (${reason}) — routing to Codex`);
    // Fix the provider hint so Codex doesn't claim to be Anthropic
    const codexSystemPrompt = options.systemPrompt.replace(
      /\[System: You are currently powered by Anthropic Claude[^\]]*\]/,
      "[System: You are currently powered by OpenAI Codex, model: gpt-5.3-codex.]"
    );
    return runCodexAgent(userMessage, history, {
      ...options,
      apiKey: options.codexApiKey!,
      model: "gpt-5.3-codex",
      provider: "codex",
      systemPrompt: codexSystemPrompt,
    });
  }

  // Does Anthropic's response or the user's message indicate action is needed?
  const responseActionSignals = /\b(I('ll| will)|let me|on it|opening|navigating|running|executing|searching|fetching|click(ing)?|downloading|checking|reading|writing|creating|deleting|sending|posting|launching|loading|ready to run|shall I|step \d|plan:)\b/i;
  const userActionSignals = /\b(open|go to|navigate|run|execute|search|click|download|check|read|write|create|delete|send|post|launch|load|show me|find|install|deploy|build|close|browse|visit)\b/i;
  const needsAction = responseActionSignals.test(anthropicText) || userActionSignals.test(userMessage);

  if (!needsAction) {
    // Pure reasoning / question answer — Anthropic handled it, no execution needed
    const messages: ChatCompletionMessageParam[] = [
      ...history,
      { role: "user", content: userMessage },
      { role: "assistant", content: anthropicText },
    ];
    onEvent?.({ type: "done", usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput } });
    return { messages, usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput }, stopReason: "end_turn" };
  }

  // Phase 2: Codex executes with full tool access
  // Pass Anthropic's plan as prior assistant context so Codex knows what was communicated
  onEvent?.({ type: "stream", delta: "\n\n" });
  const executionHistory: ChatCompletionMessageParam[] = [
    ...history,
    { role: "assistant", content: anthropicText },
  ];

  const codexSystemPrompt = options.systemPrompt.replace(
    /\[System: You are currently powered by Anthropic Claude[^\]]*\]/,
    "[System: You are currently powered by OpenAI Codex, model: gpt-5.3-codex.]"
  );
  const codexTurn = await runCodexAgent(userMessage, executionHistory, {
    ...options,
    apiKey: options.codexApiKey!,
    model: "gpt-5.3-codex",
    provider: "codex",
    systemPrompt: codexSystemPrompt,
  });

  console.log(`[orchestrator] Anthropic planned (${totalInput}in/${totalOutput}out tokens) → Codex executed (${codexTurn.usage.promptTokens}in/${codexTurn.usage.completionTokens}out)`);

  return {
    ...codexTurn,
    usage: {
      promptTokens: totalInput + codexTurn.usage.promptTokens,
      completionTokens: totalOutput + codexTurn.usage.completionTokens,
      totalTokens: totalInput + totalOutput + codexTurn.usage.totalTokens,
    },
  };
}
