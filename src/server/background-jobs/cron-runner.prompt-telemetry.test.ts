import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "../../types.js";
import {
  createPromptTelemetry,
  measurePromptSection,
  type PromptTelemetry,
} from "../../prompt-telemetry.js";
import { CRON_SYSTEM_PROMPT } from "./prompts.js";
import type { RenderedPromptSection } from "../../context/system-prompt-builder.js";

const { prepareAgentRequest, runAgentViaCanonical } = vi.hoisted(() => ({
  prepareAgentRequest: vi.fn(),
  runAgentViaCanonical: vi.fn(async () => ({
    messages: [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    stopReason: "end_turn",
  })),
}));

vi.mock("../../agent-request/index.js", () => ({ prepareAgentRequest }));
vi.mock("../../canonical-loop/index.js", () => ({ runAgentViaCanonical }));
vi.mock("../../security/index.js", () => ({
  SecurityLayer: class { constructor(_workspace: string, _mode: string) {} },
}));
vi.mock("../../security/layer/index.js", () => ({
  loadFileAccessModeAtLeast: vi.fn(() => "workspace"),
}));
vi.mock("../../autonomy/profile-store.js", () => ({
  setSessionProfile: vi.fn(),
  clearSessionProfile: vi.fn(),
}));
vi.mock("../../browser/session-owner-registry.js", () => ({
  registerSessionOwner: vi.fn(),
  clearSessionOwner: vi.fn(),
}));

import { registerCronRunner } from "./cron-runner.js";

const tool = (name: string): ToolDefinition => ({
  name,
  description: `${name} tool`,
  parameters: { type: "object", properties: {} },
  execute: async () => ({ content: "" }),
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("scheduled mission prompt telemetry", () => {
  it("passes the remeasured background prompt and filtered tools to canonical persistence", async () => {
    const allAgentTools = [tool("read"), tool("write"), tool("edit"), tool("mission_schedule_create")];
    const preparedPrompt = "prepared prompt that scheduled missions replace";
    prepareAgentRequest.mockResolvedValueOnce({
      apiKey: "key",
      provider: "anthropic",
      model: "claude-opus-4-6",
      tools: allAgentTools,
      promptTelemetry: createPromptTelemetry({
        profile: "full",
        provider: "anthropic",
        model: "claude-opus-4-6",
        prompt: preparedPrompt,
        tools: allAgentTools,
        allToolCount: allAgentTools.length,
        historyMessageCount: 0,
        sections: [measurePromptSection("core", "static", preparedPrompt)],
      }),
    });

    let execute: ((jobId: string, prompt: string, context: unknown) => Promise<unknown>) | undefined;
    const cronService = {
      onExecute: vi.fn((handler) => { execute = handler; }),
      get: vi.fn(() => ({ id: "job-1", name: "Daily research" })),
      registerRunAbort: vi.fn(),
      unregisterRunAbort: vi.fn(),
    };
    const session = { id: "cron-session", title: "", messages: [], createdAt: 0, updatedAt: 0 };

    registerCronRunner({
      config: { workspace: ".", maxIterations: 30 } as never,
      dataDir: ".",
      memoryIndex: {} as never,
      memoryManager: {} as never,
      secretsStore: {} as never,
      toolPolicy: {} as never,
      cronService: cronService as never,
      integrations: {} as never,
      allAgentTools,
      bridgeTools: [],
      cronReportsDir: ".",
      getOrCreateSession: vi.fn(() => session as never),
      saveSession: vi.fn(async () => {}),
    });

    await execute!("job-1", "research the market", {});

    const calls = runAgentViaCanonical.mock.calls as unknown as Array<[
      string,
      unknown[],
      { systemPrompt: string; tools: ToolDefinition[]; promptTelemetry: PromptTelemetry; renderedPromptSections: RenderedPromptSection[] },
    ]>;
    const options = calls[0][2];
    expect(options.systemPrompt).toBe(CRON_SYSTEM_PROMPT);
    expect(options.tools.map((entry: ToolDefinition) => entry.name)).toEqual(["read"]);
    expect(options.promptTelemetry).toMatchObject({
      profile: "full",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      characters: CRON_SYSTEM_PROMPT.length,
      loadedToolCount: 1,
      deferredToolCount: 3,
      historyMessageCount: 0,
    });
    expect(options.promptTelemetry.sections).toHaveLength(1);
    expect(options.promptTelemetry.sections[0].id).toBe("scheduled-mission");
    expect(options.renderedPromptSections).toMatchObject([{
      id: "scheduled-mission",
      policy: "required",
      text: CRON_SYSTEM_PROMPT,
    }]);
    expect(JSON.stringify(options.promptTelemetry)).not.toContain(preparedPrompt);
    expect(JSON.stringify(options.promptTelemetry)).not.toContain("research the market");
  });
});
