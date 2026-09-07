import { describe, it, expect } from "vitest";
import {
  buildSystemPrompt,
  buildSystemPromptWithTelemetry,
  fileAccessGroundingBlock,
  stableSystemPrefixLength,
} from "./build-system-prompt.js";
import { pushPendingNotification } from "../../ops/pending-notifications.js";
import type { BuildSystemPromptInput } from "./build-system-prompt.js";
import { harnessNotice, renderPromptSection } from "../../context/system-prompt-builder.js";
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
    channel: "web" as const,
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
      channel: "web",
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
    expect(opens).toHaveLength(6);
    expect(closes).toHaveLength(6);
    for (const label of [
      "BACKGROUND COMPLETIONS",
      "MEMORY NOTIFICATION",
      "TURN DIRECTIVE",
      "FILE ACCESS",
      "COLD-START HINT",
      "CHANNEL",
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
      channel: "web",
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

// C6b — the chat lane's stable/volatile cache split.
describe("stableSystemPrefixLength", () => {
  const section = (
    id: string,
    type: "static" | "dynamic",
    text: string,
  ) => renderPromptSection({ id, label: id, type, policy: "required", text });

  it("equals the byte length of the concatenated leading static sections", () => {
    const sections = [
      section("core-identity", "static", "IDENTITY"),
      section("runtime-context", "static", "RUNTIME"),
      section("agents-md", "static", "RULES"),
      section("context-block", "dynamic", "PER-TURN MEMORY"),
      section("turn-directive", "dynamic", "DO THE THING"),
    ];
    const expected = "IDENTITY".length + "RUNTIME".length + "RULES".length;

    expect(stableSystemPrefixLength(sections)).toBe(expected);
    // And it is a real PREFIX of the assembled prompt, which is the property
    // stream-api's `systemPrompt.slice(0, stableLen)` depends on.
    const prompt = sections.map((s) => s.text).join("");
    expect(prompt.slice(0, expected)).toBe("IDENTITYRUNTIMERULES");
  });

  it("is identical across two builds whose dynamic content differs", () => {
    const head = [
      section("core-identity", "static", "IDENTITY"),
      section("runtime-context", "static", "RUNTIME"),
    ];
    const a = [...head, section("context-block", "dynamic", "short")];
    const b = [
      ...head,
      section("context-block", "dynamic", "a much, much longer per-turn memory block"),
      section("turn-directive", "dynamic", "and another appended tail section"),
    ];

    expect(stableSystemPrefixLength(a)).toBe(stableSystemPrefixLength(b));
  });

  it("stops before tool-guidance, which per-turn tool selection makes volatile", () => {
    const sections = [
      section("core-identity", "static", "IDENTITY"),
      section("tool-guidance", "static", "MANIFEST THAT CHANGES EVERY TURN"),
      section("recall-reflex", "static", "REFLEX"),
    ];
    // Not "IDENTITY + MANIFEST + REFLEX" — the walk stops at the first
    // turn-variant section, so nothing after it can enter the cached prefix.
    expect(stableSystemPrefixLength(sections)).toBe("IDENTITY".length);
  });

  it("stops before project-catalog and integrations too", () => {
    for (const volatileId of ["project-catalog", "integrations"]) {
      expect(stableSystemPrefixLength([
        section("core-identity", "static", "IDENTITY"),
        section(volatileId, "static", "LIVE STATE"),
        section("recall-reflex", "static", "REFLEX"),
      ])).toBe("IDENTITY".length);
    }
  });

  it("returns undefined when nothing stable leads, so stream-api ships one block", () => {
    expect(stableSystemPrefixLength([])).toBeUndefined();
    expect(stableSystemPrefixLength([section("canary", "dynamic", "x")])).toBeUndefined();
    expect(stableSystemPrefixLength([section("tool-guidance", "static", "x")])).toBeUndefined();
  });

  it("real assembly: the prefix is stable across turns that change the dynamic tail", async () => {
    const base = (): BuildSystemPromptInput => ({
      channel: "web",
      message: "hello",
      sessionId: "sess-c6b",
      config: { systemPrompt: "Base prompt." } as BuildSystemPromptInput["config"],
      memoryIndex: {} as BuildSystemPromptInput["memoryIndex"],
      integrations: { getAgentContext: () => "" } as BuildSystemPromptInput["integrations"],
      allAgentTools: [],
      resolvedProvider: "anthropic",
      resolvedModel: "claude-test",
      contextBlock: "",
      relevantMemories: "",
      smartContext: "",
      memoryContext: "",
      memoryNotifications: [],
      memoryCurateBlock: "",
      forceBuildIntent: false,
    });

    const turn1 = await buildSystemPromptWithTelemetry(base());
    const turn2 = await buildSystemPromptWithTelemetry({
      ...base(),
      relevantMemories: "a memory recalled only on this turn",
      memoryNotifications: [{ message: "mention the thing", priority: 9 }],
      buildTurnDirective: "a turn directive that did not exist on turn 1",
    });

    const len1 = stableSystemPrefixLength(turn1.renderedSections);
    const len2 = stableSystemPrefixLength(turn2.renderedSections);
    expect(len1).toBeGreaterThan(0);
    expect(len2).toBe(len1);
    // The bytes themselves, not just the length — a same-length-but-different
    // prefix would be a cache miss AND a cache write on every turn.
    expect(turn2.prompt.slice(0, len2!)).toBe(turn1.prompt.slice(0, len1!));
    // And the prompts genuinely diverge after it, so the test is not vacuous.
    expect(turn2.prompt).not.toBe(turn1.prompt);
  });
});
