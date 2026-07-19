import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPromptTelemetry, measurePromptSection } from "../src/prompt-telemetry.js";
import type { PreparedAgentRequest } from "../src/agent-request/types.js";

let contextWindow: number | null = 8_192;
let useCloudTarget = false;

vi.mock("../src/config.js", () => ({
  getRuntimeConfig: () => ({ ollamaUrl: "http://127.0.0.1:11434" }),
}));
vi.mock("../src/local-runtimes/index.js", () => ({
  getLocalRuntimes: () => [{
    id: "ollama@127.0.0.1:11434",
    chatBaseUrl: "http://127.0.0.1:11434/v1",
    models: [{ id: "local-model", contextWindow, tools: true }],
  }],
  getRuntimeForModel: () => ({
    id: "ollama@127.0.0.1:11434",
    chatBaseUrl: "http://127.0.0.1:11434/v1",
  }),
  getLocalModelCapabilityProfile: (baseURL: string, model: string) => ({
    runtimeId: "ollama@127.0.0.1:11434",
    baseURL,
    model,
    tier: "medium",
    maxTools: 24,
    contextWindow,
    tools: { advertised: true, verified: null, rejectsTools: false },
  }),
  refreshLocalRuntimes: vi.fn(),
}));
vi.mock("../src/ollama-cloud.js", () => ({
  isCloudModel: () => useCloudTarget,
  getCloudOllamaCallTarget: () => ({ baseURL: "https://cloud.example/v1", apiKey: "cloud" }),
}));

import { registerAdapterForChat } from "../src/canonical-loop/chat-runner/register-adapter.js";
import { preflightCapabilityAwarePrompt } from "../src/canonical-loop/prompt-preflight.js";
import { unregisterAdapterForOp } from "../src/canonical-loop/runtime.js";

function prepared(): PreparedAgentRequest {
  const requiredText = "identity";
  const optionalText = "manifest:" + "m".repeat(16_000);
  const renderedPromptSections = [
    {
      id: "core-identity",
      label: "Identity",
      type: "static" as const,
      policy: "required" as const,
      text: requiredText,
      measurement: measurePromptSection("core-identity", "static", requiredText),
    },
    {
      id: "app-manifest",
      label: "App Map",
      type: "static" as const,
      policy: "degradable" as const,
      text: optionalText,
      measurement: measurePromptSection("app-manifest", "static", optionalText),
    },
  ];
  const systemPrompt = renderedPromptSections.map((section) => section.text).join("");
  return {
    provider: "local",
    apiKey: "",
    model: "local-model",
    systemPrompt,
    tools: [],
    cleanHistory: [],
    images: [],
    temperature: 0.7,
    maxIterations: 30,
    reasoningEffort: "medium",
    promptTelemetry: createPromptTelemetry({
      profile: "full",
      provider: "local",
      model: "local-model",
      prompt: systemPrompt,
      tools: [],
      allToolCount: 0,
      historyMessageCount: 0,
      sections: renderedPromptSections.map((section) => section.measurement),
    }),
    renderedPromptSections,
    localModelCapabilityProfile: null,
  };
}

beforeEach(() => {
  contextWindow = 8_192;
  useCloudTarget = false;
});

describe("local prompt preflight", () => {
  it("uses evidence from the exact resolved endpoint before prompt persistence", async () => {
    const request = prepared();
    const originalTools = request.tools;
    await preflightCapabilityAwarePrompt(request);

    expect(request.localModelCapabilityProfile).toMatchObject({
      baseURL: "http://127.0.0.1:11434/v1",
      model: "local-model",
      contextWindow: 8_192,
    });
    expect(request.systemPrompt).toBe("identity");
    expect(request.promptTelemetry.degradation).toMatchObject({ mode: "constrained-local" });
    expect(request.promptTelemetry.characters).toBe(request.systemPrompt.length);
    expect(request.tools).toBe(originalTools);
  });

  it("leaves a local-picker cloud target byte-for-byte unchanged", async () => {
    useCloudTarget = true;
    const request = prepared();
    const original = request.systemPrompt;
    await preflightCapabilityAwarePrompt(request);

    expect(request.localModelCapabilityProfile).toBeNull();
    expect(request.systemPrompt).toBe(original);
    expect(request.promptTelemetry.degradation).toMatchObject({ mode: "full", reason: "not-local-target" });
  });

  it("registers the same target that supplied the preflight evidence", async () => {
    const request = prepared();
    const target = await preflightCapabilityAwarePrompt(request);
    useCloudTarget = true;

    try {
      await registerAdapterForChat("op-prompt-target-pin", request, "sess-target-pin", target);
      expect(request.localModelCapabilityProfile).toMatchObject({
        baseURL: "http://127.0.0.1:11434/v1",
        contextWindow: 8_192,
      });
    } finally {
      unregisterAdapterForOp("op-prompt-target-pin");
    }
  });
});
