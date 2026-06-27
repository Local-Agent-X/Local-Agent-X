import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { ToolDefinition, ServerEvent } from "../types.js";
import type { SecurityLayer } from "../security/index.js";
import type { ToolPolicy } from "../tool-policy.js";
import type { ThreatEngine } from "../threat/threat-engine.js";
import type { RBACManager, Role } from "../rbac.js";
import type { ProviderId } from "./provider-ids.js";

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

/**
 * Per-(baseURL, model, param) memory of request params an endpoint's model
 * rejects with a hard 400 — e.g. grok-4.20-0309-reasoning 400s the whole
 * request on `reasoning_effort` ("does not support parameter reasoningEffort").
 * Same (baseURL, model) keying rationale as _noToolSupport: the same model
 * name behind a different endpoint may accept the param. Seeded with the one
 * model we already know rejects reasoning_effort so its first call skips the
 * failed round-trip; the openai-http catch records the rest at runtime.
 */
function paramKey(baseURL: string | undefined, model: string, param: string): string {
  return `${baseURL ?? ""}::${model}::${param}`;
}

const _seedUnsupportedParams: ReadonlyArray<[string, string, string]> = [
  ["https://api.x.ai/v1", "grok-4.20-0309-reasoning", "reasoning_effort"],
];

const _unsupportedParams = new Set<string>(
  _seedUnsupportedParams.map(([b, m, p]) => paramKey(b, m, p)),
);

export function hasParamUnsupported(baseURL: string | undefined, model: string, param: string): boolean {
  return _unsupportedParams.has(paramKey(baseURL, model, param));
}

export function markParamUnsupported(baseURL: string | undefined, model: string, param: string): void {
  _unsupportedParams.add(paramKey(baseURL, model, param));
}

/** Test-only: reset to the seeded state so test ordering doesn't leak state. */
export function _resetUnsupportedParamsForTests(): void {
  _unsupportedParams.clear();
  for (const [b, m, p] of _seedUnsupportedParams) _unsupportedParams.add(paramKey(b, m, p));
}

export type { ChatCompletionMessageParam };
