import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "../../types.js";
import { sessionWorkRootOf } from "../../workspace/paths.js";
import {
  createPromptTelemetry,
  measurePromptSection,
  type PromptTelemetry,
} from "../../prompt-telemetry.js";
import { CRON_SYSTEM_PROMPT } from "./prompts.js";
import type { RenderedPromptSection } from "../../context/system-prompt-builder.js";

const { prepareAgentRequest, runAgentViaCanonical, allowedPaths, seenDuringRun } = vi.hoisted(() => ({
  prepareAgentRequest: vi.fn(),
  allowedPaths: new Map<string, string>(),
  seenDuringRun: { workRoot: undefined as string | undefined },
  runAgentViaCanonical: vi.fn(),
}));

vi.mock("../../agent-request/index.js", () => ({ prepareAgentRequest }));
vi.mock("../../canonical-loop/index.js", () => ({ runAgentViaCanonical }));
vi.mock("../../security/index.js", () => ({
  SecurityLayer: class {
    constructor(_workspace: string, _mode: string) {}
    addAllowedPath(p: string, sessionId: string) { allowedPaths.set(sessionId, p); }
    removeAllowedPath(_p: string, sessionId: string) { allowedPaths.delete(sessionId); }
  },
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

let workspace: string;
beforeEach(() => {
  vi.clearAllMocks();
  allowedPaths.clear();
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "lax-cron-runner-")));
  runAgentViaCanonical.mockImplementation(async (_prompt: string, _history: unknown[], opts: { sessionId: string }) => {
    seenDuringRun.workRoot = sessionWorkRootOf(opts.sessionId);
    return { messages: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, stopReason: "end_turn" };
  });
});
afterEach(() => rmSync(workspace, { recursive: true, force: true }));

describe("scheduled mission prompt telemetry", () => {
  it("passes the remeasured background prompt and filtered tools to canonical persistence", async () => {
    const allAgentTools = [tool("read"), tool("write"), tool("edit"), tool("edit_lines"), tool("bash"), tool("mission_schedule_create")];
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
      config: { workspace, maxIterations: 30 } as never,
      dataDir: workspace,
      memoryIndex: {} as never,
      memoryManager: {} as never,
      secretsStore: {} as never,
      toolPolicy: {} as never,
      cronService: cronService as never,
      integrations: {} as never,
      allAgentTools,
      bridgeTools: [],
      cronReportsDir: join(workspace, "reports"),
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
    const missionDir = join(workspace, "missions", "daily-research");
    expect(options.systemPrompt.startsWith(CRON_SYSTEM_PROMPT)).toBe(true);
    expect(options.systemPrompt).toContain(`All your work happens under: ${missionDir.replace(/\\/g, "/")}`);
    // Only scheduling is taken away: every write and shell tool reaches the
    // run, and the worker-run gates decide each call.
    expect(options.tools.map((entry: ToolDefinition) => entry.name)).toEqual(["read", "write", "edit", "edit_lines", "bash"]);
    expect(options.promptTelemetry).toMatchObject({
      profile: "full",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      characters: options.systemPrompt.length,
      loadedToolCount: 5,
      deferredToolCount: 1,
      historyMessageCount: 0,
    });
    expect(options.promptTelemetry.sections.map((s) => s.id)).toEqual(["scheduled-mission", "work-folder"]);
    expect(options.renderedPromptSections).toMatchObject([
      { id: "scheduled-mission", policy: "required", text: CRON_SYSTEM_PROMPT },
      { id: "work-folder", policy: "required" },
    ]);
    // The job's folder is the run's work root while it runs, and only then.
    expect(existsSync(missionDir)).toBe(true);
    expect(seenDuringRun.workRoot).toBe(missionDir);
    const sessionId = (runAgentViaCanonical.mock.calls[0] as unknown as [string, unknown[], { sessionId: string }])[2].sessionId;
    expect(sessionWorkRootOf(sessionId)).toBeUndefined();
    expect(allowedPaths.size).toBe(0);
    expect(JSON.stringify(options.promptTelemetry)).not.toContain(preparedPrompt);
    expect(JSON.stringify(options.promptTelemetry)).not.toContain("research the market");
  });
});
