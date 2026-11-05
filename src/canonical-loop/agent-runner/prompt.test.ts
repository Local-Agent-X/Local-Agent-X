import { beforeEach, describe, expect, it } from "vitest";
import { renderPromptSection } from "../../context/system-prompt-builder.js";
import type { LocalModelCapabilityProfile } from "../../local-runtimes/index.js";
import type { CanonicalAgentOptions } from "./types.js";
import { prepareCanonicalAgentPrompt, splitForChatThread } from "./prompt.js";

let contextWindow: number | null = 8_192;

function profile(window: number | null = contextWindow): LocalModelCapabilityProfile {
  return {
    runtimeId: "ollama@agent-test",
    baseURL: "http://127.0.0.1:11434/v1",
    model: "agent-local",
    tier: "medium",
    maxTools: 24,
    contextWindow: window,
    tools: { advertised: true, verified: null, rejectsTools: false },
  };
}

function options(): CanonicalAgentOptions {
  const required = "voice-mode";
  const optional = "manifest:" + "m".repeat(16_000);
  return {
    apiKey: "",
    model: "agent-local",
    provider: "local",
    systemPrompt: required + optional,
    renderedPromptSections: [
      renderPromptSection({
        id: "voice-mode", label: "Voice Mode", type: "static", policy: "required", text: required,
      }),
      renderPromptSection({
        id: "app-manifest", label: "App Map", type: "static", policy: "degradable", text: optional,
      }),
    ],
    tools: [],
    security: {} as CanonicalAgentOptions["security"],
  };
}

beforeEach(() => {
  contextWindow = 8_192;
});

describe("canonical agent final prompt seam", () => {
  it("rejects a prompt whose explicit section plan does not match its bytes", async () => {
    const dispatch = options();
    dispatch.systemPrompt += "unclassified-tail";
    await expect(prepareCanonicalAgentPrompt(dispatch, [], profile())).rejects.toThrow(
      "prompt sections do not match systemPrompt bytes",
    );
  });

  it("degrades a constrained local prompt while preserving the required voice section", async () => {
    const dispatch = options();
    await prepareCanonicalAgentPrompt(dispatch, [], profile());
    expect(dispatch.systemPrompt).not.toContain("manifest:");
    expect(dispatch.systemPrompt).toBe("voice-mode");
    expect(dispatch.renderedPromptSections.map((section) => section.id)).toEqual(["voice-mode"]);
    expect(dispatch.promptTelemetry?.characters).toBe(dispatch.systemPrompt.length);
    expect(dispatch.promptTelemetry?.degradation).toMatchObject({
      mode: "constrained-local",
      contextEvidence: "measured",
      degradedSections: [{ id: "app-manifest" }],
    });
  });

  it("uses the conservative floor and labels unknown local evidence", async () => {
    contextWindow = null;
    const dispatch = options();
    await prepareCanonicalAgentPrompt(dispatch, [], profile());

    expect(dispatch.systemPrompt).not.toContain("manifest:");
    expect(dispatch.promptTelemetry?.degradation).toMatchObject({
      contextEvidence: "unknown",
      assumedContextWindowTokens: 8_192,
    });
  });

  it.each([
    ["scheduled-mission", "cron-required"],
    ["delegation-ack", "delegation-required"],
  ])("preserves standalone required plan %s under unknown local evidence", async (id, text) => {
    contextWindow = null;
    const dispatch = options();
    dispatch.systemPrompt = text;
    dispatch.renderedPromptSections = [renderPromptSection({
      id, label: id, type: "static", policy: "required", text,
    })];
    await prepareCanonicalAgentPrompt(dispatch, [], profile());

    expect(dispatch.systemPrompt).toBe(text);
    expect(dispatch.renderedPromptSections).toMatchObject([{ id, policy: "required", text }]);
    expect(dispatch.promptTelemetry?.degradation).toMatchObject({
      contextEvidence: "unknown",
      degradedSections: [],
    });
  });

  it("keeps local-picker cloud bytes unchanged and records no local profile", async () => {
    const dispatch = options();
    const original = dispatch.systemPrompt;
    await prepareCanonicalAgentPrompt(dispatch, [], null);

    expect(dispatch.systemPrompt).toBe(original);
    expect(dispatch.localModelCapabilityProfile).toBeNull();
    expect(dispatch.promptTelemetry?.degradation).toMatchObject({
      mode: "full",
      reason: "not-local-target",
    });
  });

  it("keeps a measured local prompt that fits its window share byte-for-byte unchanged", async () => {
    contextWindow = 65_536;
    const dispatch = options();
    const original = dispatch.systemPrompt;
    await prepareCanonicalAgentPrompt(dispatch, [], profile());

    expect(dispatch.systemPrompt).toBe(original);
    expect(dispatch.promptTelemetry?.degradation).toMatchObject({
      mode: "full",
      reason: "within-prompt-budget",
      contextEvidence: "measured",
      promptBudgetTokens: Math.floor(65_536 * 0.35),
    });
  });

  it("uses the exact caller-provided local profile for degradation", async () => {
    const dispatch = options();
    await prepareCanonicalAgentPrompt(dispatch, [], profile(16_384));
    expect(dispatch.localModelCapabilityProfile).toMatchObject({
      baseURL: "http://127.0.0.1:11434/v1",
      contextWindow: 16_384,
    });
  });
});

// op_messages has no system role, so the seeder drops a history's system rows.
// The /api/compact summary is one; without the fold a spoken turn (or any
// agent-runner op) on a compacted thread ran without it.
describe("the history's system rows reach the prompt", () => {
  const compacted = [
    { role: "system" as const, content: "[Conversation summary] we chose Postgres" },
    { role: "user" as const, content: "and the port?" },
  ];

  it("folds them in as a required system-history section", async () => {
    const dispatch = options();
    await prepareCanonicalAgentPrompt(dispatch, compacted, profile(null));
    expect(dispatch.systemPrompt).toContain("we chose Postgres");
    const section = dispatch.renderedPromptSections.find((s) => s.id === "system-history");
    expect(section).toMatchObject({ policy: "required" });
  });

  it("leaves a prompt that already carries them alone", async () => {
    const dispatch = options();
    dispatch.systemPrompt += "\n\n[Conversation summary] we chose Postgres";
    dispatch.renderedPromptSections.push(renderPromptSection({
      id: "system-history", label: "System History", type: "dynamic", policy: "required", text: "\n\n[Conversation summary] we chose Postgres",
    }));
    await prepareCanonicalAgentPrompt(dispatch, compacted, profile(null));
    expect(dispatch.systemPrompt.match(/we chose Postgres/g)).toHaveLength(1);
  });
});

describe("a turn saved to a chat thread (voice)", () => {
  function spoken(provider: CanonicalAgentOptions["provider"]): CanonicalAgentOptions {
    const sections = [
      renderPromptSection({ id: "core-identity/identity", label: "Identity", type: "static", policy: "required", text: "IDENTITY " }),
      renderPromptSection({ id: "voice-mode", label: "Voice Mode", type: "static", policy: "required", text: "SPEAK " }),
      renderPromptSection({ id: "relevant-memories", label: "Recall", type: "dynamic", policy: "degradable", text: "RECALL " }),
    ];
    return { ...options(), provider, model: "qwen3.8:27b", systemPrompt: sections.map((s) => s.text).join(""), renderedPromptSections: sections, savedToChat: true };
  }

  it("on a local wire sends chat's stable prefix and hands the per-message sections to the seed", () => {
    const dispatch = spoken("local");
    const recalled = splitForChatThread(dispatch, "s-voice-split");
    expect(dispatch.systemPrompt).toBe("IDENTITY SPEAK ");
    expect(recalled).toContain("RECALL");
  });

  it("leaves a cloud turn's prompt whole", () => {
    const dispatch = spoken("anthropic");
    expect(splitForChatThread(dispatch, "s-voice-cloud")).toBeNull();
    expect(dispatch.systemPrompt).toBe("IDENTITY SPEAK RECALL ");
  });

  it("leaves a turn nobody saves to a chat alone", () => {
    const dispatch = { ...spoken("local"), savedToChat: false };
    expect(splitForChatThread(dispatch, "s-background")).toBeNull();
    expect(dispatch.systemPrompt).toBe("IDENTITY SPEAK RECALL ");
  });
});
