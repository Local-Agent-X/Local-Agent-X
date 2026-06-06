import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { ToolDefinition, LAXConfig } from "../types.js";
import type { MemoryIndex, MemoryManager } from "../memory/index.js";
import type { IntegrationRegistry } from "../integrations/index.js";
import type { SecretsStore } from "../secrets.js";

export type ChannelKind = "web" | "telegram" | "whatsapp" | "cron" | "agent";

export interface AgentRequestInput {
  /** Which entry point is calling */
  channel: ChannelKind;
  /** The user's message */
  message: string;
  /** Session messages (raw, will be sanitized) */
  sessionMessages: ChatCompletionMessageParam[];
  /** Session ID for the agent run */
  sessionId: string;
  /** App config */
  config: LAXConfig;
  /** Data directory (~/.lax) */
  dataDir: string;
  /** Memory index for context building */
  memoryIndex: MemoryIndex;
  /** High-level memory facade (per-turn context, persistence, search). */
  memoryManager: MemoryManager;
  /** Integration registry for API context */
  integrations: IntegrationRegistry;
  /** Secrets store for API key lookups */
  secretsStore: SecretsStore;
  /** Full tool set (web chat) */
  allAgentTools: ToolDefinition[];
  /** Slimmed tool set (bridges, Codex) */
  bridgeTools: ToolDefinition[];
  /** Skip heavy memory orchestrator (bridges, cron) */
  skipMemory?: boolean;
  /** Lean prep: skip the intent classifier + memory-curate steps whose
   *  output the caller discards (voice overrides tools + prompt). Keeps
   *  memory/context + system-prompt build. Cuts ~2 pre-model LLM round-trips
   *  off time-to-first-token for those callers. */
  leanPrep?: boolean;
  /** Override system prompt (sub-agents) */
  systemPromptOverride?: string;
  /** Max messages to keep in history (default 30 for bridges, 40 for web) */
  maxHistory?: number;
  /** Bridge-specific context string (platform, channel, formatting rules) */
  bridgeContext?: string;
  /** Image attachments */
  attachments?: Array<{ isImage: boolean; url: string; name: string }>;
  /** Uploads directory for resolving attachment paths */
  uploadsDir?: string;
  /** Force a specific provider for this turn. Used by per-job cron model
   *  selection so a mission can pin itself to e.g. opus regardless of the
   *  user's current chat provider. Falls through to auto-detect if the
   *  named provider lacks credentials (see resolve-provider.ts). */
  providerOverride?: string;
  /** Force a specific model. Pairs with providerOverride. */
  modelOverride?: string;
  /*
   * (compactedSummary / compactedAt were here before. Compaction now lives
   * as a leading system message in sessionMessages — see types.ts
   * COMPACTION_PREFIX. prepare-request no longer special-cases it.)
   */
}

/**
 * Forced tool selection for this turn. When set, the LLM adapter pins
 * tool_choice to the named tool — used by the intent classifier to
 * collapse build_app / agent_spawn / self_edit prose-leaks into real
 * tool calls. Undefined means "auto" (LLM picks freely).
 */
export type ForcedToolChoice = { type: "tool"; name: string };

export interface PreparedAgentRequest {
  provider: string;
  apiKey: string;
  model: string;
  codexApiKey?: string;
  customBaseURL?: string;
  systemPrompt: string;
  tools: ToolDefinition[];
  cleanHistory: ChatCompletionMessageParam[];
  images: Array<{ url: string; filePath?: string; name: string }>;
  temperature: number;
  maxIterations: number;
  /** Force a single tool for this turn — see intent-classifier.ts. */
  toolChoice?: ForcedToolChoice;
}
