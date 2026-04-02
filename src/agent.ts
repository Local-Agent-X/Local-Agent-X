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
  if (options.provider === "codex") {
    turn = await runCodexAgent(userMessage, history, options);
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
