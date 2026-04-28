/**
 * Context Builder regression tests.
 *
 * Verifies section ordering, cache boundary placement, and split behavior.
 */

import { describe, it, expect } from "vitest";
import { createSystemPromptBuilder, ContextBuilder, CACHE_BOUNDARY } from "./context-builder.js";

const MOCK_INPUTS = {
  basePrompt: "You are a personal AI companion.",
  providerHint: "\n\n[System: powered by Codex]",
  toolPromptSection: "\n\n## Tool Guidance\nUse read not cat.",
  integrationsContext: "\n\nConnected: GitHub",
  contextBlock: "\n\n--- MEMORY ---\nUser prefers concise.\n--- END ---",
  relevantMemories: "\n\n--- RELEVANT ---\nUser works on Local Agent X.\n--- END ---",
  smartContext: "",
  memoryContext: "\n\n[Memory: focused]",
  notificationHint: "",
  canaryBlock: "\n\n<!-- canary:abc123 -->",
};

describe("Context Builder", () => {
  it("places static sections before cache boundary, dynamic after", async () => {
    const builder = createSystemPromptBuilder(MOCK_INPUTS);
    const output = await builder.build();

    expect(output).toContain(CACHE_BOUNDARY);
    const { stablePrefix, dynamicSuffix } = ContextBuilder.split(output);

    // Static sections in prefix
    expect(stablePrefix).toContain("personal AI companion");
    expect(stablePrefix).toContain("powered by Codex");
    expect(stablePrefix).toContain("Tool Guidance");
    expect(stablePrefix).toContain("Connected: GitHub");

    // Dynamic sections in suffix
    expect(dynamicSuffix).toContain("MEMORY");
    expect(dynamicSuffix).toContain("RELEVANT");
    expect(dynamicSuffix).toContain("[Memory: focused]");
    expect(dynamicSuffix).toContain("canary:abc123");
  });

  it("skips empty optional sections", async () => {
    const builder = createSystemPromptBuilder(MOCK_INPUTS);
    const output = await builder.build();

    // smartContext and notificationHint are empty — should not appear
    expect(output).not.toContain("RELATED PAST SESSIONS");
    expect(output).not.toContain("Naturally weave");
  });

  it("maintains deterministic section order", async () => {
    const builder = createSystemPromptBuilder(MOCK_INPUTS);
    const order = builder.getSectionOrder();

    expect(order[0]).toBe("core-identity");
    expect(order[1]).toBe("provider-hint");
    expect(order).toContain("context-block");
    expect(order).toContain("canary");
    // Canary should be last
    expect(order[order.length - 1]).toBe("canary");
  });

  it("split returns full prompt as stablePrefix when no boundary", () => {
    const { stablePrefix, dynamicSuffix } = ContextBuilder.split("no boundary here");
    expect(stablePrefix).toBe("no boundary here");
    expect(dynamicSuffix).toBe("");
  });

  it("includes bridge context when provided", async () => {
    const builder = createSystemPromptBuilder({
      ...MOCK_INPUTS,
      bridgeContext: "\n\n[WhatsApp bridge] Keep concise.",
    });
    const output = await builder.build();
    expect(output).toContain("WhatsApp bridge");
  });
});
