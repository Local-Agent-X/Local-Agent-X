import { describe, it, expect } from "vitest";
import { buildSystemPrompt, fileAccessGroundingBlock } from "./build-system-prompt.js";
import { pushPendingNotification } from "../../ops/pending-notifications.js";
import type { BuildSystemPromptInput } from "./build-system-prompt.js";

describe("fileAccessGroundingBlock", () => {
  it("unrestricted tells the model it can read ANY file", () => {
    const block = fileAccessGroundingBlock("unrestricted");
    expect(block).toContain("[HARNESS NOTE: FILE ACCESS]");
    expect(block).toContain("Mode: UNRESTRICTED.");
    expect(block).toContain("ANY file");
    // The whole point: no grounds for refusal beyond missing / credential files.
    expect(block).toMatch(/does not exist or is a blocked credential/i);
  });

  it("common names the allowed roots and points at Settings, not 'unable'", () => {
    const block = fileAccessGroundingBlock("common");
    expect(block).toContain("[HARNESS NOTE: FILE ACCESS]");
    expect(block).toContain("Mode: COMMON.");
    expect(block).toMatch(/Documents/);
    expect(block).toMatch(/Settings/);
    expect(block).toMatch(/don't claim you are simply unable/i);
  });

  it("workspace says reads are blocked BY POLICY (not a missing tool) and mentions Settings", () => {
    const block = fileAccessGroundingBlock("workspace");
    expect(block).toContain("[HARNESS NOTE: FILE ACCESS]");
    expect(block).toContain("Mode: WORKSPACE-ONLY.");
    expect(block).toMatch(/BY POLICY/);
    expect(block).toMatch(/not by a missing tool/i);
    expect(block).toMatch(/Settings/);
  });

  it("every mode produces a non-empty, prefixed block", () => {
    for (const mode of ["unrestricted", "common", "workspace"] as const) {
      const block = fileAccessGroundingBlock(mode);
      expect(block.startsWith("\n\n[HARNESS NOTE: FILE ACCESS]")).toBe(true);
      expect(block.length).toBeGreaterThan(40);
    }
  });
});

describe("unified harness-notice format", () => {
  // Regression for the five-wrapper unification: every first-party harness
  // notice (background completions, memory notification, turn directive,
  // file access, cold-start hint) must emit through harnessNotice(), and no
  // old-style wrapper may survive anywhere in the assembled prompt.
  it("all five notices emit as [HARNESS NOTE: <LABEL>] blocks with zero old-style markers", async () => {
    const sessionId = `harness-note-regression-${Date.now()}`;
    pushPendingNotification(sessionId, {
      opId: "op-hn-1",
      status: "completed",
      summary: "did the thing",
      filesChanged: [],
      task: "build the widget",
      completedAt: Date.now(),
    });

    const input: BuildSystemPromptInput = {
      message: "build me a landing page for my gym", // trips COLD_START_VERBS
      sessionId,
      config: { systemPrompt: "Base prompt." } as BuildSystemPromptInput["config"],
      memoryIndex: {} as BuildSystemPromptInput["memoryIndex"],
      integrations: { getAgentContext: () => "" } as BuildSystemPromptInput["integrations"],
      allAgentTools: [],
      resolvedProvider: "local",
      resolvedModel: "test-model",
      contextBlock: "",
      relevantMemories: "",
      smartContext: "",
      memoryContext: "",
      memoryNotifications: [{ message: "user's birthday is today", priority: 1 }],
      memoryCurateBlock: "",
      forceBuildIntent: true, // fires the TURN DIRECTIVE (non-lean)
    };

    const prompt = await buildSystemPrompt(input);

    const opens = prompt.match(/\[HARNESS NOTE: /g) ?? [];
    const closes = prompt.match(/\[END HARNESS NOTE\]/g) ?? [];
    expect(opens).toHaveLength(5);
    expect(closes).toHaveLength(5);
    for (const label of [
      "BACKGROUND COMPLETIONS",
      "MEMORY NOTIFICATION",
      "TURN DIRECTIVE",
      "FILE ACCESS",
      "COLD-START HINT",
    ]) {
      expect(prompt).toContain(`[HARNESS NOTE: ${label}]`);
    }

    // Old-style wrappers must be gone.
    expect(prompt).not.toContain("[BACKGROUND COMPLETIONS");
    expect(prompt).not.toContain("[end background completions]");
    expect(prompt).not.toContain("[Naturally weave into your response:");
    expect(prompt).not.toContain("--- TURN DIRECTIVE ---");
    expect(prompt).not.toContain("--- END TURN DIRECTIVE ---");
    expect(prompt).not.toContain("[FILE ACCESS:");
    expect(prompt).not.toContain("[COLD-START HINT]");
  });
});
