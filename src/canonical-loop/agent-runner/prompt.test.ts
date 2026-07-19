import { beforeEach, describe, expect, it } from "vitest";
import { renderPromptSection } from "../../context/system-prompt-builder.js";
import type { LocalModelCapabilityProfile } from "../../local-runtimes/index.js";
import type { CanonicalAgentOptions } from "./types.js";
import { prepareCanonicalAgentPrompt } from "./prompt.js";

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

  it("keeps a measured capable local prompt byte-for-byte unchanged", async () => {
    contextWindow = 65_536;
    const dispatch = options();
    const original = dispatch.systemPrompt;
    await prepareCanonicalAgentPrompt(dispatch, [], profile());

    expect(dispatch.systemPrompt).toBe(original);
    expect(dispatch.promptTelemetry?.degradation).toMatchObject({
      mode: "full",
      reason: "capability-not-constrained",
      contextEvidence: "measured",
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
