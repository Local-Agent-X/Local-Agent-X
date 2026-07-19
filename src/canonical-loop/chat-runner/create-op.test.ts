import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPromptTelemetry, measurePromptSection } from "../../prompt-telemetry.js";

const { appendOpMessage, writeOp } = vi.hoisted(() => ({
  appendOpMessage: vi.fn(),
  writeOp: vi.fn(),
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
      provider: "local",
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
        provider: "local",
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
      "core", "chat-augmentations", "system-history",
    ]);
    expect(telemetry.sections.reduce((sum, section) => sum + section.characters, 0)).toBe(finalPrompt.length);
    expect(JSON.stringify(telemetry)).not.toContain(compactSummary);
    expect(JSON.stringify(telemetry)).not.toContain(truncationDigest);

    const systemRowsPersistedAsMessages = appendOpMessage.mock.calls.filter(
      ([row]) => (row as { role?: string }).role === "system",
    );
    expect(systemRowsPersistedAsMessages).toHaveLength(0);
  });
});
