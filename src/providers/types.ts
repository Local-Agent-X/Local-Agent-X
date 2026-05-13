import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { ToolDefinition, ServerEvent } from "../types.js";
import type { SecurityLayer } from "../security.js";
import type { ToolPolicy } from "../tool-policy.js";
import type { ThreatEngine } from "../threat-engine.js";
import type { RBACManager, Role } from "../rbac.js";

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

/**
 * Cache of (baseURL, model) pairs that we've learned don't support the
 * tools field on chat.completions. Set once per (endpoint, model) so the
 * first leg of the empty-response retry only fires once.
 *
 * Keyed by both baseURL and model because the same model name can live
 * behind different endpoints with different capabilities. `qwen2:7b` on a
 * local Ollama doesn't support tools; `qwen2:7b` on Ollama Turbo cloud
 * does. Earlier this Set was keyed by model alone — the "no tools"
 * finding from one endpoint poisoned every other endpoint's tool support
 * for that same model name. (AUDIT Critical #4.)
 */
const _noToolSupport = new Set<string>();

function noToolKey(baseURL: string | undefined, model: string): string {
  return `${baseURL ?? ""}::${model}`;
}

export function hasNoToolSupport(baseURL: string | undefined, model: string): boolean {
  return _noToolSupport.has(noToolKey(baseURL, model));
}

export function markNoToolSupport(baseURL: string | undefined, model: string): void {
  _noToolSupport.add(noToolKey(baseURL, model));
}

/** Test-only: reset the cache so test ordering doesn't leak state. */
export function _resetNoToolSupportForTests(): void {
  _noToolSupport.clear();
}

export type { ChatCompletionMessageParam };
