/**
 * Tool-shape translation — single source of truth for converting our
 * internal ToolDefinition[] into each provider's expected wire format.
 *
 * Before: every adapter inlined its own `tools.map(t => ({...}))` and the
 * Anthropic vs OpenAI shapes drifted whenever someone added a new field.
 * After: every adapter calls one of these helpers; field changes happen
 * here once.
 *
 * Shape references:
 *   OpenAI chat: { type: "function", function: { name, description, parameters } }
 *   Anthropic:   { name, description, input_schema, cache_control? }
 *   Codex:       { type: "function", name, description, parameters }
 *   Gemini:      { functionDeclarations: [{ name, description, parameters }] }
 */

import type { ToolDefinition } from "../../types.js";

export type ProviderToolShapeInput = Pick<ToolDefinition, "name" | "description" | "parameters">;
export type ToolSchemaFormat =
  | "openai-chat"
  | "anthropic-api"
  | "anthropic-oauth"
  | "anthropic-dynamic"
  | "anthropic-cli-managed"
  | "codex-responses"
  | "gemini-native";

export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  cache_control?: { type: "ephemeral" };
}

export interface CodexTool {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface GeminiToolEnvelope {
  functionDeclarations: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }>;
}

export function toOpenAITools(tools: readonly ProviderToolShapeInput[]): OpenAITool[] {
  return tools.map(t => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export function toAnthropicTools(
  tools: readonly ProviderToolShapeInput[],
  options: {
    mapName?: (name: string) => string;
    cacheControlLast?: boolean;
  } = {},
): AnthropicTool[] {
  const shaped: AnthropicTool[] = tools.map(t => ({
    name: options.mapName?.(t.name) ?? t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
  if (options.cacheControlLast && shaped.length > 0) {
    shaped[shaped.length - 1].cache_control = { type: "ephemeral" };
  }
  return shaped;
}

export function toCodexTools(tools: readonly ProviderToolShapeInput[]): CodexTool[] {
  return tools.map(t => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

const GEMINI_SCHEMA_KEYS = new Set([
  "type", "description", "nullable", "enum", "properties", "required",
  "items", "minItems", "maxItems", "minimum", "maximum", "format",
]);
const GEMINI_FORMATS = new Set(["enum", "date-time"]);

export function toGeminiSchema(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object") return { type: "string" };
  const node = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (!GEMINI_SCHEMA_KEYS.has(key)) continue;
    if (key === "format") {
      if (typeof value === "string" && GEMINI_FORMATS.has(value)) out.format = value;
      continue;
    }
    out[key] = value;
  }
  if (out.type === "object" || out.properties) {
    out.type = "object";
    const properties = node.properties && typeof node.properties === "object"
      ? node.properties as Record<string, unknown>
      : {};
    const clean: Record<string, unknown> = {};
    for (const [name, schema] of Object.entries(properties)) clean[name] = toGeminiSchema(schema);
    out.properties = clean;
    if (Array.isArray(node.required)) {
      const required = (node.required as unknown[]).filter(
        (name): name is string => typeof name === "string" && name in clean,
      );
      if (required.length > 0) out.required = required;
      else delete out.required;
    }
  }
  if (out.type === "array" || out.items) {
    out.type = "array";
    out.items = toGeminiSchema(node.items ?? { type: "string" });
  }
  if (!out.type) out.type = "string";
  return out;
}

export function toGeminiTools(tools: readonly ProviderToolShapeInput[]): GeminiToolEnvelope[] {
  return [{
    functionDeclarations: tools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: toGeminiSchema(t.parameters),
    })),
  }];
}

export function toolSchemaFormatForProvider(
  provider: string,
  authSource?: string,
): ToolSchemaFormat {
  if (provider === "anthropic") {
    return authSource === "oauth" ? "anthropic-dynamic" : "anthropic-api";
  }
  if (provider === "codex") return "codex-responses";
  if (provider === "gemini") return "gemini-native";
  return "openai-chat";
}

export function toolSchemaFormatForDispatch(
  provider: string,
  preparedFormat: ToolSchemaFormat,
  preferAnthropicDirectHttp: boolean,
): ToolSchemaFormat {
  if (provider === "anthropic"
    && !preferAnthropicDirectHttp
    && (preparedFormat === "anthropic-oauth" || preparedFormat === "anthropic-dynamic")) {
    return "anthropic-cli-managed";
  }
  return preparedFormat;
}

export function toProviderToolSchemaPayload(
  format: ToolSchemaFormat,
  tools: readonly ProviderToolShapeInput[],
  options: { mapAnthropicOAuthName?: (name: string) => string } = {},
): unknown {
  switch (format) {
    case "anthropic-api":
      return toAnthropicTools(tools, { cacheControlLast: true });
    case "anthropic-oauth":
      return toAnthropicTools(tools, {
        mapName: options.mapAnthropicOAuthName,
        cacheControlLast: true,
      });
    case "anthropic-dynamic":
    case "anthropic-cli-managed":
      return null;
    case "codex-responses":
      return toCodexTools(tools);
    case "gemini-native":
      return toGeminiTools(tools);
    case "openai-chat":
      return toOpenAITools(tools);
  }
}
