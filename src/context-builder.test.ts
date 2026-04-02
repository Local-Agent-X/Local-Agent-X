/**
 * Context Builder regression tests.
 *
 * Verifies that the new modular builder produces identical output
 * to the old flat concatenation for both chat and agent prompts.
 */

import { describe, it, expect } from "vitest";
import { createChatContextBuilder, ContextBuilder } from "./context-builder.js";

// Simulate the inputs a real chat session would produce
const MOCK_INPUTS = {
  systemPrompt: "You are a personal AI companion running inside Open Agent X.\n\n## Tooling\nTool names are case-sensitive.",
  providerHint: "\n\n[System: You are currently powered by OpenAI Codex, model: gpt-5.3-codex.]",
  toolPromptSection: "\n\n## Tool Best Practices\n- **read**: Use read for files instead of bash cat.\n- **grep**: ALWAYS use grep for content search.\n",
  contextBlock: "\n\n--- MEMORY ---\nUser prefers concise responses.\n--- END ---",
  relevantMemories: "\n\n--- RELEVANT ---\nUser works on Open Agent X project.\n--- END ---",
  smartContext: "\n\n--- RELATED PAST SESSIONS ---\nDiscussed tool expansion.\n--- END ---",
  memoryContext: "\n\n[Memory: emotional state: focused]",
  notificationHint: "\n\n[Naturally weave into your response: Calendar event in 30 minutes]",
  integrationsContext: "\n\nConnected: GitHub, Slack",
  canaryBlock: "\n\n<!-- canary:abc123 -->",
};

describe("Context Builder output equivalence", () => {
  it("produces identical output to flat concatenation for full chat", async () => {
    // Old approach: flat string concatenation (the exact order from chat.ts line 150)
    const oldOutput =
      MOCK_INPUTS.systemPrompt +
      MOCK_INPUTS.providerHint +
      MOCK_INPUTS.toolPromptSection +
      MOCK_INPUTS.contextBlock +
      MOCK_INPUTS.relevantMemories +
      MOCK_INPUTS.smartContext +
      MOCK_INPUTS.memoryContext +
      MOCK_INPUTS.notificationHint +
      MOCK_INPUTS.integrationsContext +
      MOCK_INPUTS.canaryBlock;

    // New approach: context builder
    const builder = createChatContextBuilder(MOCK_INPUTS);
    const newOutput = await builder.build();

    expect(newOutput).toBe(oldOutput);
  });

  it("produces identical output when optional sections are empty", async () => {
    const sparse = {
      ...MOCK_INPUTS,
      toolPromptSection: "",
      smartContext: "",
      memoryContext: "",
      notificationHint: "",
      integrationsContext: "",
    };

    const oldOutput =
      sparse.systemPrompt +
      sparse.providerHint +
      sparse.contextBlock +
      sparse.relevantMemories +
      sparse.canaryBlock;

    const builder = createChatContextBuilder(sparse);
    const newOutput = await builder.build();

    expect(newOutput).toBe(oldOutput);
  });

  it("maintains deterministic section order", async () => {
    const builder = createChatContextBuilder(MOCK_INPUTS);
    const order = builder.getSectionOrder();

    expect(order).toEqual([
      "core-identity",
      "provider-hint",
      "tool-guidance",
      "context-block",
      "relevant-memories",
      "smart-context",
      "memory-orchestrator",
      "notifications",
      "integrations",
      "canary",
    ]);
  });

  it("caches static sections on second build", async () => {
    let callCount = 0;
    const builder = new ContextBuilder();
    builder.addSection({
      id: "test-static",
      label: "Test",
      type: "static",
      build: () => { callCount++; return "static content"; },
    });
    builder.addSection({
      id: "test-dynamic",
      label: "Test Dynamic",
      type: "dynamic",
      build: () => "dynamic content",
    });

    await builder.build();
    expect(callCount).toBe(1);

    await builder.build();
    expect(callCount).toBe(1); // static was cached

    builder.invalidateStatic();
    await builder.build();
    expect(callCount).toBe(2); // cache cleared, rebuilt
  });
});
