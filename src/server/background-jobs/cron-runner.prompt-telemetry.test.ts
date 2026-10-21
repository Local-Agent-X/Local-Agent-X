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
const { broadcastAll, setJobExistsCheck } = vi.hoisted(() => ({ broadcastAll: vi.fn(), setJobExistsCheck: vi.fn() }));
vi.mock("../../browser/session-owner-registry.js", () => ({
  registerSessionOwner: vi.fn(),
  clearSessionOwner: vi.fn(),
  jobBrowserProfile: vi.fn(() => ({ kind: "job", jobId: "job" })),
  setJobExistsCheck,
}));
vi.mock("../../chat-ws/index.js", () => ({ broadcastAll }));
const { setJobSecretPlanSource } = vi.hoisted(() => ({ setJobSecretPlanSource: vi.fn() }));
vi.mock("../../cron/job-secret-plan.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../cron/job-secret-plan.js")>()),
  setJobSecretPlanSource,
}));
vi.mock("../../browser/index.js", () => ({ closeBrowser: vi.fn(async () => undefined) }));

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
      onChange: vi.fn(),
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
      integrations: { getAgentContext: () => "" } as never,
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

// A job's key plan reaches its run as names and sites: the model knows which
// key to use where, and never sees a value.
describe("a scheduled run's instructions name its key plan", () => {
  async function systemPromptFor(job: Record<string, unknown>): Promise<{ systemPrompt: string; ids: string[] }> {
    const tools = [tool("http_request")];
    prepareAgentRequest.mockResolvedValueOnce({
      apiKey: "key", provider: "anthropic", model: "claude-opus-4-6", tools,
      promptTelemetry: createPromptTelemetry({
        profile: "full", provider: "anthropic", model: "claude-opus-4-6", prompt: "p", tools,
        allToolCount: 1, historyMessageCount: 0, sections: [measurePromptSection("core", "static", "p")],
      }),
    });
    let execute: ((jobId: string, prompt: string, context: unknown) => Promise<unknown>) | undefined;
    registerCronRunner({
      config: { workspace, maxIterations: 30 } as never, dataDir: workspace, memoryIndex: {} as never, memoryManager: {} as never,
      secretsStore: {} as never, toolPolicy: {} as never,
      cronService: { onExecute: vi.fn((h) => { execute = h; }), onChange: vi.fn(), get: vi.fn(() => job), registerRunAbort: vi.fn(), unregisterRunAbort: vi.fn() } as never,
      integrations: { getAgentContext: () => "" } as never, allAgentTools: tools, bridgeTools: [], cronReportsDir: join(workspace, "reports"),
      getOrCreateSession: vi.fn(() => ({ id: "s", title: "", messages: [], createdAt: 0, updatedAt: 0 }) as never), saveSession: vi.fn(async () => {}),
    });
    await execute!(String(job.id), "check the projects", {});
    const options = (runAgentViaCanonical.mock.calls[0] as unknown as [string, unknown[], { systemPrompt: string; renderedPromptSections: RenderedPromptSection[] }])[2];
    return { systemPrompt: options.systemPrompt, ids: options.renderedPromptSections.map((s) => s.id) };
  }

  it("lists each planned key at its site", async () => {
    const { systemPrompt, ids } = await systemPromptFor({
      id: "job-1", name: "Supabase check",
      secretPlan: [{ name: "SUPABASE_MGMT_TOKEN", destination: "https://api.supabase.com" }],
    });
    expect(ids).toEqual(["scheduled-mission", "work-folder", "job-keys"]);
    expect(systemPrompt).toContain("- SUPABASE_MGMT_TOKEN at https://api.supabase.com");
    expect(systemPrompt).toContain("Use these keys for these sites");
  });

  it("says nothing about keys without a plan", async () => {
    const { systemPrompt, ids } = await systemPromptFor({ id: "job-2", name: "Plain" });
    expect(ids).toEqual(["scheduled-mission", "work-folder"]);
    expect(systemPrompt).not.toContain("Keys this job may use");
  });
});

// The server's half of "every change to the missions list reaches every open
// tab": the cron service's change notice becomes the frame tabs redraw from,
// and a job the service no longer has can never open its browser profile.
describe("the server's cron wiring", () => {
  it("broadcasts the service's change notices and shuts a deleted job's browser profile", () => {
    let changed: (() => void) | undefined;
    const jobs = new Set(["job-1"]);
    const cronService = {
      onExecute: vi.fn(),
      onChange: vi.fn((listener: () => void) => { changed = listener; }),
      get: vi.fn((id: string) => (jobs.has(id) ? { id } : null)),
    };
    registerCronRunner({
      config: { workspace } as never, dataDir: workspace, memoryIndex: {} as never, memoryManager: {} as never,
      secretsStore: {} as never, toolPolicy: {} as never, cronService: cronService as never,
      integrations: {} as never, allAgentTools: [], bridgeTools: [], cronReportsDir: workspace,
      getOrCreateSession: vi.fn(), saveSession: vi.fn(async () => {}),
    });
    changed!();
    expect(broadcastAll).toHaveBeenCalledWith({ type: "settings_changed", settings: { missions: true } });
    const exists = setJobExistsCheck.mock.calls[0][0] as (jobId: string) => boolean;
    expect(exists("job-1")).toBe(true);
    jobs.delete("job-1");
    expect(exists("job-1")).toBe(false);
  });

  it("gives the vault's ladder each job's key plan, read live from the service", () => {
    const plan = [{ name: "K", destination: "https://api.example.com" }];
    const job: { id: string; secretPlan?: typeof plan } = { id: "job-1", secretPlan: plan };
    const cronService = { onExecute: vi.fn(), onChange: vi.fn(), get: vi.fn((id: string) => (id === "job-1" ? job : null)) };
    registerCronRunner({
      config: { workspace } as never, dataDir: workspace, memoryIndex: {} as never, memoryManager: {} as never,
      secretsStore: {} as never, toolPolicy: {} as never, cronService: cronService as never,
      integrations: {} as never, allAgentTools: [], bridgeTools: [], cronReportsDir: workspace,
      getOrCreateSession: vi.fn(), saveSession: vi.fn(async () => {}),
    });
    const source = setJobSecretPlanSource.mock.calls[0][0] as (jobId: string) => unknown;
    expect(source("job-1")).toEqual(plan);
    job.secretPlan = undefined;
    expect(source("job-1")).toBeUndefined();
    expect(source("gone")).toBeUndefined();
  });
});
