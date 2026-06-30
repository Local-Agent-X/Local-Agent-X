import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { ToolDefinition, ServerEvent } from "../types.js";
import type { SecurityLayer } from "../security/index.js";
import type { ToolPolicy } from "../tool-policy.js";
import type { ThreatEngine } from "../threat/threat-engine.js";
import type { RBACManager, Role } from "../rbac.js";
import type { ProviderId } from "./provider-ids.js";
import * as capStore from "./model-capabilities-store.js";

export interface ImageAttachment {
  url: string;
  filePath?: string;
  name: string;
}

export interface AgentOptions {
  apiKey: string;
  model: string;
  baseURL?: string;
  provider: ProviderId;
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

/**
 * (baseURL, model) capability lookups, backed by the persistent, seeded
 * model-capabilities registry (see ./model-capabilities-store). These thin
 * wrappers keep the openai-http / openai-compat call sites stable while the
 * facts they read and write now survive restarts and ship with a public
 * seed — instead of evaporating from an in-memory Set on every cold start.
 *
 * Keyed by (baseURL, model): the same model name behind different endpoints
 * has different capabilities — qwen2:7b on local Ollama can't do tools,
 * qwen2:7b on Ollama Turbo can. (AUDIT Critical #4.)
 */
export function hasNoToolSupport(baseURL: string | undefined, model: string): boolean {
  return capStore.hasNoTools(baseURL, model);
}

export function markNoToolSupport(baseURL: string | undefined, model: string): void {
  capStore.recordNoTools(baseURL, model);
}

export function hasParamUnsupported(baseURL: string | undefined, model: string, param: string): boolean {
  return capStore.hasUnsupportedParam(baseURL, model, param);
}

export function markParamUnsupported(baseURL: string | undefined, model: string, param: string): void {
  capStore.recordUnsupportedParam(baseURL, model, param);
}

/** Test-only: reset the in-memory learned layer so test ordering doesn't leak state. */
export function _resetNoToolSupportForTests(): void {
  capStore._resetForTests();
}

/** Test-only: alias of the above — the learned layer is one store now. */
export function _resetUnsupportedParamsForTests(): void {
  capStore._resetForTests();
}

export type { ChatCompletionMessageParam };
