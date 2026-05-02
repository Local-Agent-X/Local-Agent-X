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
 *   OpenAI:    { type: "function", function: { name, description, parameters } }
 *   Anthropic: { name, description, input_schema }
 */

import type { ToolDefinition } from "../../types.js";

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
}

export function toOpenAITools(tools: ToolDefinition[]): OpenAITool[] {
  return tools.map(t => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export function toAnthropicTools(tools: ToolDefinition[]): AnthropicTool[] {
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}
