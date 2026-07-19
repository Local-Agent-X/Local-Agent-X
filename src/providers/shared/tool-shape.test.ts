import { describe, expect, it } from "vitest";
import { toOAuthWireName } from "../../anthropic-client/oauth-direct.js";
import {
  toolSchemaFormatForDispatch,
  toolSchemaFormatForProvider,
  toProviderToolSchemaPayload,
  type ToolSchemaFormat,
} from "./tool-shape.js";

const tool = {
  name: "memory_search",
  description: "Search memory",
  parameters: {
    type: "object",
    properties: { query: { type: "string", format: "uri", secretInternalFlag: true } },
    required: ["query", "missing"],
    additionalProperties: false,
  },
  execute: "must-not-leak",
  effect: { class: "read-only", operationKey: "must-not-leak" },
};

describe("provider tool wire shapes", () => {
  it.each(
    [
    ["openai-chat", [{
      type: "function",
      function: { name: "memory_search", description: "Search memory", parameters: tool.parameters },
    }]],
    ["anthropic-api", [{
      name: "memory_search", description: "Search memory", input_schema: tool.parameters,
      cache_control: { type: "ephemeral" },
    }]],
    ["anthropic-oauth", [{
      name: "lax_memory_search", description: "Search memory", input_schema: tool.parameters,
      cache_control: { type: "ephemeral" },
    }]],
    ["codex-responses", [{
      type: "function", name: "memory_search", description: "Search memory", parameters: tool.parameters,
    }]],
    ["gemini-native", [{
      functionDeclarations: [{
        name: "memory_search",
        description: "Search memory",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      }],
    }]],
    ] as Array<[ToolSchemaFormat, unknown]>,
  )("serializes the exact %s payload and excludes internal metadata", (format, expected) => {
    const payload = toProviderToolSchemaPayload(format, [tool], {
      mapAnthropicOAuthName: toOAuthWireName,
    });

    expect(payload).toEqual(expected);
    expect(JSON.stringify(payload)).not.toContain("must-not-leak");
  });

  it("selects the actual provider transport including Anthropic auth mode", () => {
    expect(toolSchemaFormatForProvider("local", "sentinel")).toBe("openai-chat");
    expect(toolSchemaFormatForProvider("anthropic", "env")).toBe("anthropic-api");
    expect(toolSchemaFormatForProvider("anthropic", "oauth")).toBe("anthropic-dynamic");
    expect(toolSchemaFormatForProvider("codex", "oauth")).toBe("codex-responses");
    expect(toolSchemaFormatForProvider("gemini", "env")).toBe("gemini-native");
  });

  it("keeps Anthropic chat fallback honest and resolves background dispatch to managed CLI", () => {
    expect(toolSchemaFormatForDispatch("anthropic", "anthropic-dynamic", true))
      .toBe("anthropic-dynamic");
    expect(toolSchemaFormatForDispatch("anthropic", "anthropic-dynamic", false))
      .toBe("anthropic-cli-managed");
  });
});
