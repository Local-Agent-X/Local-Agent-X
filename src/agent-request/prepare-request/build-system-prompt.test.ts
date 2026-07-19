import { describe, it, expect } from "vitest";
import {
  buildSystemPrompt,
  buildSystemPromptWithTelemetry,
  fileAccessGroundingBlock,
} from "./build-system-prompt.js";
import { pushPendingNotification } from "../../ops/pending-notifications.js";
import type { BuildSystemPromptInput } from "./build-system-prompt.js";
import { harnessNotice } from "../../context/system-prompt-builder.js";
import { loadFileAccessMode } from "../../security/layer/index.js";
import { modelFamilyRiderFor } from "./provider-riders.js";

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

describe("local model-family rider wiring", () => {
  const inputFor = (provider: string, model: string): BuildSystemPromptInput => ({
    message: "hi there", // must not trip COLD_START_VERBS
    sessionId: `family-rider-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    config: { systemPrompt: "Base prompt." } as BuildSystemPromptInput["config"],
    memoryIndex: {} as BuildSystemPromptInput["memoryIndex"],
    integrations: { getAgentContext: () => "" } as BuildSystemPromptInput["integrations"],
    allAgentTools: [],
    resolvedProvider: provider,
    resolvedModel: model,
    contextBlock: "",
    relevantMemories: "",
    smartContext: "",
    memoryContext: "",
    memoryNotifications: [],
    memoryCurateBlock: "",
    forceBuildIntent: false,
  });

  it("provider local + gemma model → base family rider present, no reasoning addition", async () => {
    const prompt = await buildSystemPrompt(inputFor("local", "gemma3:27b"));
    expect(prompt).toContain("[LOCAL MODEL RIDER");
    expect(prompt).toContain("[END LOCAL MODEL RIDER]");
    expect(prompt).not.toContain("DELIBERATE BRIEFLY");
  });

  it("provider local + qwen model → reasoning addition present", async () => {
    const prompt = await buildSystemPrompt(inputFor("local", "qwen3:32b"));
    expect(prompt).toContain("[LOCAL MODEL RIDER");
    expect(prompt).toContain("DELIBERATE BRIEFLY, ANSWER FIRST");
  });

  it("non-local providers never get the family rider, even for the same model id", async () => {
    for (const provider of ["anthropic", "codex", "xai", "openai", "gemini", "ollama-cloud"]) {
      const prompt = await buildSystemPrompt(inputFor(provider, "gemma3:27b"));
      expect(prompt).not.toContain("[LOCAL MODEL RIDER");
    }
  });

  it("rider sits in the dynamic tail, after the file-access block", async () => {
    const prompt = await buildSystemPrompt(inputFor("local", "qwen3:32b"));
    const fileAccessAt = prompt.indexOf("[HARNESS NOTE: FILE ACCESS]");
    const riderAt = prompt.indexOf("[LOCAL MODEL RIDER");
    expect(fileAccessAt).toBeGreaterThanOrEqual(0);
    expect(riderAt).toBeGreaterThan(fileAccessAt);
  });

  it("sub-agent override branch gets the rider too — local only", async () => {
    const local = { ...inputFor("local", "qwen3:32b"), systemPromptOverride: "You are a focused sub-agent." };
    expect(await buildSystemPrompt(local)).toContain("[LOCAL MODEL RIDER");
    const cloud = { ...inputFor("anthropic", "qwen3:32b"), systemPromptOverride: "You are a focused sub-agent." };
    expect(await buildSystemPrompt(cloud)).not.toContain("[LOCAL MODEL RIDER");
  });

  it("keeps cloud and local prompt assembly byte-exact and section-complete", async () => {
    const localBase = {
      ...inputFor("local", "qwen3:32b"),
      systemPromptOverride: "Canonical prompt bytes.",
      forceBuildIntent: true,
      buildMode: "force" as const,
      intentReason: "golden build route",
    };
    const local = await buildSystemPromptWithTelemetry(localBase);
    const cloud = await buildSystemPromptWithTelemetry({
      ...localBase,
      resolvedProvider: "openai",
    });

    const expectedLocalPrompt =
      "Canonical prompt bytes." +
      fileAccessGroundingBlock(loadFileAccessMode()) +
      modelFamilyRiderFor("qwen3:32b") +
      harnessNotice(
        "TURN DIRECTIVE",
        "Intent classifier identified this turn as a build_app request: golden build route.\n" +
        "Call the build_app tool \u2014 that is the ONLY way to build this. The build then runs as a background op (the \"side agent\") that owns the ENTIRE build: it runs the real toolchain, produces the artifact, and delivers the result to the user itself when done. " +
        "Do NOT build it yourself this turn \u2014 no bash/cargo/compiler, no write/edit of source files, no send_image of a result you produced. Building it twice wastes minutes of compute and confuses the user with a duplicate output. " +
        "After calling build_app, just briefly tell the user it's building and they'll see it when it's ready.",
      );
    expect(local.prompt).toBe(expectedLocalPrompt);
    for (const result of [local, cloud]) {
      expect(result.renderedSections.map((section) => section.text).join("")).toBe(result.prompt);
      expect(new Set(result.renderedSections.map((section) => section.id)).size)
        .toBe(result.renderedSections.length);
      expect(result.renderedSections.find((section) => section.id === "file-access")?.policy)
        .toBe("required");
      expect(result.renderedSections.find((section) => section.id === "turn-directive")?.policy)
        .toBe("required");
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

describe("Product Build turn directive", () => {
  it("injects the canonical resolved action, project, and reason", async () => {
    const directive =
      'Product Build continuation resolved to action=build_plan_resume with project_dir="C:/apps/crm". ' +
      'Reason: the persisted build is halted. Call build_plan_resume with project_dir="C:/apps/crm" now.';
    const prompt = await buildSystemPrompt({
      message: "continue the build",
      sessionId: "product-build-directive",
      config: { systemPrompt: "Base prompt." } as BuildSystemPromptInput["config"],
      memoryIndex: {} as BuildSystemPromptInput["memoryIndex"],
      integrations: { getAgentContext: () => "" } as BuildSystemPromptInput["integrations"],
      allAgentTools: [],
      resolvedProvider: "openai",
      resolvedModel: "gpt-5",
      contextBlock: "",
      relevantMemories: "",
      smartContext: "",
      memoryContext: "",
      memoryNotifications: [],
      memoryCurateBlock: "",
      forceBuildIntent: true,
      buildTurnDirective: directive,
      systemPromptOverride: "Base prompt.",
    });
    expect(prompt).toContain("[HARNESS NOTE: TURN DIRECTIVE]");
    expect(prompt).toContain(directive);
    expect(prompt).not.toContain("Call the build_app tool");
  });
});
