import { describe, expect, it } from "vitest";
import {
  createPromptTelemetry,
  measurePromptSection,
  remeasurePromptTelemetry,
} from "./prompt-telemetry.js";
import { estimateTokens } from "./context-manager/token-estimation.js";
import type { ToolDefinition } from "./types.js";

describe("prompt telemetry", () => {
  it("records sizes and counts without retaining prompt content", () => {
    const secretText = "private prompt text";
    const telemetry = createPromptTelemetry({
      profile: "full",
      provider: "local",
      model: "small-model",
      prompt: secretText,
      tools: [{ name: "read", description: "Read a file", parameters: {} }],
      allToolCount: 4,
      historyMessageCount: 3,
      sections: [measurePromptSection("core", "static", secretText)],
    });

    expect(telemetry.characters).toBe(secretText.length);
    expect(telemetry.utf8Bytes).toBe(Buffer.byteLength(secretText, "utf8"));
    expect(telemetry.loadedToolCount).toBe(1);
    expect(telemetry.deferredToolCount).toBe(3);
    expect(telemetry.historyMessageCount).toBe(3);
    expect(JSON.stringify(telemetry)).not.toContain(secretText);
    expect(JSON.stringify(telemetry)).not.toContain("Read a file");
  });

  it.each([
    {
      provider: "xai", authSource: "oauth", format: "openai-chat",
      expected: [{
        type: "function",
        function: {
          name: "memory_search", description: "Read a file",
          parameters: {
            type: "object",
            properties: { path: { type: "string", format: "uri" } },
            required: ["path", "missing"],
            additionalProperties: false,
          },
        },
      }],
    },
    {
      provider: "anthropic", authSource: "env", format: "anthropic-api",
      expected: [{
        name: "memory_search", description: "Read a file",
        input_schema: {
          type: "object",
          properties: { path: { type: "string", format: "uri" } },
          required: ["path", "missing"],
          additionalProperties: false,
        },
        cache_control: { type: "ephemeral" },
      }],
    },
    {
      provider: "codex", authSource: "oauth", format: "codex-responses",
      expected: [{
        type: "function", name: "memory_search", description: "Read a file",
        parameters: {
          type: "object",
          properties: { path: { type: "string", format: "uri" } },
          required: ["path", "missing"],
          additionalProperties: false,
        },
      }],
    },
    {
      provider: "gemini", authSource: "env", format: "gemini-native",
      expected: [{
        functionDeclarations: [{
          name: "memory_search", description: "Read a file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        }],
      }],
    },
  ])("measures the exact $format provider wire shape", ({ provider, authSource, format, expected }) => {
    const tool: ToolDefinition = {
      name: "memory_search",
      description: "Read a file",
      parameters: {
        type: "object",
        properties: { path: { type: "string", format: "uri" } },
        required: ["path", "missing"],
        additionalProperties: false,
      },
      execute: async () => ({ content: "" }),
      effect: { class: "read-only", operationKey: "internal-operation-key" },
      readOnly: true,
      concurrencySafe: true,
      audiences: ["main-chat", "spawned-agent"],
    };
    const telemetry = createPromptTelemetry({
      profile: "full",
      provider,
      model: "small-model",
      authSource,
      prompt: "prompt",
      tools: [tool],
      allToolCount: 1,
      historyMessageCount: 0,
      sections: [],
    });

    expect(telemetry.toolSchemaFormat).toBe(format);
    expect(telemetry.toolSchemaEstimatedTokens).toBe(estimateTokens(JSON.stringify(expected)));
    expect(JSON.stringify(telemetry)).not.toContain("internal-operation-key");
  });

  it("marks Anthropic subscription dispatch as dynamic instead of persisting a false wire count", () => {
    const telemetry = createPromptTelemetry({
      profile: "full", provider: "anthropic", model: "claude-test", authSource: "oauth",
      prompt: "prompt", tools: [{
        name: "memory_search", description: "Read a file",
        parameters: { type: "object", properties: {} },
      }], allToolCount: 1, historyMessageCount: 0, sections: [],
    });

    expect(telemetry.toolSchemaFormat).toBe("anthropic-dynamic");
    expect(telemetry.toolSchemaEstimatedTokens).toBeNull();
  });

  it("records zero schema tokens when the provider sends no tools field", () => {
    const telemetry = createPromptTelemetry({
      profile: "full", provider: "local", model: "small-model", prompt: "prompt",
      tools: [], allToolCount: 4, historyMessageCount: 0, sections: [],
    });

    expect(telemetry.toolSchemaFormat).toBe("openai-chat");
    expect(telemetry.toolSchemaEstimatedTokens).toBe(0);
  });

  it("remeasures the final dispatch without retaining appended content", () => {
    const basePrompt = "base prompt";
    const appended = "private canary and turn context";
    const baseline = createPromptTelemetry({
      profile: "full",
      provider: "local",
      model: "small-model",
      prompt: basePrompt,
      tools: [
        { name: "read", description: "Read", parameters: {} },
        { name: "write", description: "Write", parameters: {} },
      ],
      allToolCount: 4,
      historyMessageCount: 2,
      sections: [measurePromptSection("core", "static", basePrompt)],
    });

    const telemetry = remeasurePromptTelemetry({
      baseline,
      prompt: basePrompt + appended,
      tools: [{ name: "read", description: "Read", parameters: {} }],
      historyMessageCount: 5,
      appendedSection: { id: "chat-augmentations", type: "dynamic", text: appended },
    });

    expect(telemetry.characters).toBe((basePrompt + appended).length);
    expect(telemetry.loadedToolCount).toBe(1);
    expect(telemetry.deferredToolCount).toBe(3);
    expect(telemetry.historyMessageCount).toBe(5);
    expect(telemetry.sections.at(-1)?.id).toBe("chat-augmentations");
    expect(JSON.stringify(telemetry)).not.toContain(appended);
  });
});
