import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPromptTelemetry, measurePromptSection } from "../../prompt-telemetry.js";

const { appendOpMessage, writeOp } = vi.hoisted(() => ({
  appendOpMessage: vi.fn(),
  writeOp: vi.fn(),
}));

vi.mock("../../config.js", () => ({
  getRuntimeConfig: () => ({ ollamaUrl: "http://127.0.0.1:11434" }),
}));
vi.mock("../../local-runtimes/index.js", () => ({
  getLocalRuntimes: () => [{
    id: "ollama@test",
    chatBaseUrl: "http://127.0.0.1:11434/v1",
    models: [{ id: "local-small", contextWindow: 8_192, tools: true }],
  }],
  getRuntimeForModel: () => ({ id: "ollama@test", chatBaseUrl: "http://127.0.0.1:11434/v1" }),
  getLocalModel: () => ({ id: "local-small", contextWindow: 8_192, tools: true }),
  getLocalModelCapabilityProfile: (baseURL: string, model: string) => ({
    runtimeId: "ollama@test", baseURL, model, tier: "medium", maxTools: 24,
    contextWindow: 8_192,
    tools: { advertised: true, verified: null, rejectsTools: false },
  }),
  refreshLocalRuntimes: vi.fn(),
}));
vi.mock("../../ollama-cloud.js", () => ({
  isCloudModel: () => false,
  getCloudOllamaCallTarget: () => null,
}));

vi.mock("../store.js", () => ({ appendOpMessage }));
vi.mock("../../ops/op-store.js", () => ({
  newOpId: vi.fn(() => "op_chat_turn_prompt_telemetry"),
  writeOp,
}));
vi.mock("../../ops/context-pack-builder.js", () => ({
  buildContextPack: vi.fn(async () => ({ routing: {}, budget: {}, secrets: { allowed: [] } })),
}));
vi.mock("../../ops/heartbeat.js", () => ({ getRetryPolicy: vi.fn(() => ({})) }));
vi.mock("../../ops/session-bridge.js", () => ({ trackOpForSession: vi.fn() }));

import { createChatOp } from "./create-op.js";

beforeEach(() => {
  appendOpMessage.mockClear();
  writeOp.mockClear();
});

describe("createChatOp prompt telemetry", () => {
  it("persists the final dispatch after compact and truncation rows are folded exactly once", async () => {
    const basePrompt = "base system prompt";
    const augmentation = "\n\nprivate canary";
    const compactSummary = "[COMPACTED HISTORY]\nThe user already chose blue.";
    const truncationDigest = "<prior_conversation>Earlier work shipped.</prior_conversation>";
    const prepared = {
      provider: "openai",
      model: "qwen-test",
      maxIterations: 30,
      systemPrompt: basePrompt + augmentation,
      cleanHistory: [
        { role: "system", content: compactSummary },
        { role: "system", content: truncationDigest },
        { role: "user", content: "continue" },
      ],
      images: [],
      renderedPromptSections: [
        {
          id: "core",
          label: "Core",
          type: "static" as const,
          policy: "required" as const,
          text: basePrompt,
          measurement: measurePromptSection("core", "static", basePrompt),
        },
        {
          id: "security-canary",
          label: "Security Canary",
          type: "dynamic" as const,
          policy: "required" as const,
          text: augmentation,
          measurement: measurePromptSection("security-canary", "dynamic", augmentation),
        },
      ],
      promptTelemetry: createPromptTelemetry({
        profile: "full",
        provider: "openai",
        model: "qwen-test",
        prompt: basePrompt,
        tools: [],
        allToolCount: 1,
        historyMessageCount: 3,
        sections: [measurePromptSection("core", "static", basePrompt)],
      }),
    };
    const tools = [{
      name: "read",
      description: "Read a file",
      parameters: { type: "object", properties: {} },
      execute: vi.fn(),
    }];

    await createChatOp({
      message: "continue",
      sessionId: "sess-prompt-final",
      prepared,
      tools,
    } as never);

    const finalPrompt = [basePrompt + augmentation, compactSummary, truncationDigest].join("\n\n");
    expect(prepared.systemPrompt).toBe(finalPrompt);
    expect(prepared.systemPrompt.match(/COMPACTED HISTORY/g)).toHaveLength(1);
    expect(prepared.systemPrompt.match(/prior_conversation/g)).toHaveLength(2);
    expect(prepared.renderedPromptSections.map((section) => section.text).join(""))
      .toBe(finalPrompt);
    expect(prepared.renderedPromptSections.at(-1)).toMatchObject({
      id: "system-history",
      policy: "required",
    });

    const persisted = writeOp.mock.calls[0][0] as {
      contextPack: { promptTelemetry: ReturnType<typeof createPromptTelemetry> };
    };
    const telemetry = persisted.contextPack.promptTelemetry;
    expect(telemetry.characters).toBe(finalPrompt.length);
    expect(telemetry.utf8Bytes).toBe(Buffer.byteLength(finalPrompt, "utf8"));
    expect(telemetry.sections.map(section => section.id)).toEqual([
      "core", "security-canary", "system-history",
    ]);
    expect(telemetry.sections.reduce((sum, section) => sum + section.characters, 0)).toBe(finalPrompt.length);
    expect(JSON.stringify(telemetry)).not.toContain(compactSummary);
    expect(JSON.stringify(telemetry)).not.toContain(truncationDigest);

    const systemRowsPersistedAsMessages = appendOpMessage.mock.calls.filter(
      ([row]) => (row as { role?: string }).role === "system",
    );
    expect(systemRowsPersistedAsMessages).toHaveLength(0);
  });

  it("budgets after required system history is appended and persists the final section plan", async () => {
    const required = "identity";
    const optional = "manifest:" + "m".repeat(8_000);
    const compactSummary = "[COMPACTED HISTORY]\n" + "h".repeat(14_000);
    const prepared = {
      provider: "local",
      apiKey: "",
      model: "local-small",
      maxIterations: 30,
      systemPrompt: required + optional,
      cleanHistory: [
        { role: "system", content: compactSummary },
        { role: "user", content: "continue" },
      ],
      images: [],
      tools: [],
      renderedPromptSections: [
        {
          id: "core",
          label: "Core",
          type: "static" as const,
          policy: "required" as const,
          text: required,
          measurement: measurePromptSection("core", "static", required),
        },
        {
          id: "app-manifest",
          label: "App Map",
          type: "static" as const,
          policy: "degradable" as const,
          text: optional,
          measurement: measurePromptSection("app-manifest", "static", optional),
        },
      ],
      promptTelemetry: createPromptTelemetry({
        profile: "full",
        provider: "local",
        model: "local-small",
        prompt: required + optional,
        tools: [],
        allToolCount: 0,
        historyMessageCount: 2,
        sections: [
          measurePromptSection("core", "static", required),
          measurePromptSection("app-manifest", "static", optional),
        ],
      }),
      localModelCapabilityProfile: null,
    };

    await createChatOp({
      message: "continue",
      sessionId: "sess-final-budget",
      prepared,
      tools: [],
    } as never);

    expect(prepared.systemPrompt).not.toContain("manifest:");
    expect(prepared.systemPrompt).toContain(compactSummary);
    expect(prepared.renderedPromptSections.map((section) => section.id)).toEqual(["core", "system-history"]);
    expect(prepared.promptTelemetry.sections.map((section) => section.id)).toEqual(["core", "system-history"]);
    expect(prepared.promptTelemetry.characters).toBe(prepared.systemPrompt.length);
    expect(prepared.promptTelemetry.degradation).toMatchObject({
      mode: "constrained-local",
      reason: "required-sections-exceed-budget",
      includedSectionIds: ["core", "system-history"],
      degradedSections: [{ id: "app-manifest" }],
    });
    const persisted = writeOp.mock.calls.at(-1)![0] as {
      contextPack: { promptTelemetry: ReturnType<typeof createPromptTelemetry> };
    };
    expect(persisted.contextPack.promptTelemetry).toEqual(prepared.promptTelemetry);
  });
});
