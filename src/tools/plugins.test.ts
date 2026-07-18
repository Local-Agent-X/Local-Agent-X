import { describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "../types.js";
import type { ToolPluginContext } from "./plugin.js";
import { allTools } from "../tools.js";
import { unifiedRegistry } from "./registry.js";
import { bindBuildAppRuntime, plugins } from "./plugins.js";

function buildApp(execute: ToolDefinition["execute"]): ToolDefinition {
  return {
    name: "build_app",
    description: "test builder",
    parameters: { type: "object", properties: {} },
    execute,
  };
}

describe("bindBuildAppRuntime", () => {
  it("relays the calling session's active local Gemma runtime", async () => {
    const execute = vi.fn(async () => ({ content: "queued" }));
    const runtimes = new Map([
      ["gemma-session", { provider: "local", model: "google/gemma-4-e4b" }],
      ["other-session", { provider: "local", model: "other-model" }],
    ]);
    const bound = bindBuildAppRuntime(buildApp(execute), runtimes);
    const args: Record<string, unknown> = {
      name: "kanban",
      prompt: "build it",
      _sessionId: "gemma-session",
    };

    await bound.execute(args);

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      _runtimeProvider: "local",
      _runtimeModel: "google/gemma-4-e4b",
    }), undefined);
    expect(args).toEqual({ name: "kanban", prompt: "build it", _sessionId: "gemma-session" });
  });

  it("fills provider and model independently without changing partial overrides", async () => {
    const execute = vi.fn(async () => ({ content: "queued" }));
    const bound = bindBuildAppRuntime(
      buildApp(execute),
      new Map([["session", { provider: "local", model: "google/gemma-4-e4b" }]]),
    );
    const args = {
      name: "kanban",
      prompt: "build it",
      _sessionId: "session",
      _runtimeProvider: "codex",
    };

    await bound.execute(args);

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      _runtimeProvider: "codex",
      _runtimeModel: "google/gemma-4-e4b",
    }), undefined);
    expect(args).toEqual({
      name: "kanban",
      prompt: "build it",
      _sessionId: "session",
      _runtimeProvider: "codex",
    });
  });

  it("does not leak runtime fields when one args object is reused across sessions", async () => {
    const received: Record<string, unknown>[] = [];
    const execute: ToolDefinition["execute"] = vi.fn(async (callArgs) => {
      received.push(callArgs);
      return { content: "queued" };
    });
    const bound = bindBuildAppRuntime(buildApp(execute), new Map([
      ["a", { provider: "local", model: "gemma-a" }],
      ["b", { provider: "local", model: "gemma-b" }],
    ]));
    const args: Record<string, unknown> = { name: "app", prompt: "build", _sessionId: "a" };

    await bound.execute(args);
    args._sessionId = "b";
    await bound.execute(args);

    expect(received[0]).toEqual(expect.objectContaining({ _runtimeModel: "gemma-a" }));
    expect(received[1]).toEqual(expect.objectContaining({ _runtimeModel: "gemma-b" }));
    expect(args).toEqual({ name: "app", prompt: "build", _sessionId: "b" });
  });

  it("repeated wrapping uses only the newest session runtime", async () => {
    const execute = vi.fn(async () => ({ content: "queued" }));
    const first = bindBuildAppRuntime(
      buildApp(execute),
      new Map([["session", { provider: "local", model: "stale-model" }]]),
    );
    const second = bindBuildAppRuntime(
      first,
      new Map([["session", { provider: "local", model: "current-model" }]]),
    );

    await second.execute({ _sessionId: "session" });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ _runtimeModel: "current-model" }), undefined);
  });

  it("core registration replaces allTools and unifiedRegistry with one metadata-preserving definition", async () => {
    const core = plugins.find((plugin) => plugin.id === "core");
    expect(core).toBeDefined();
    const original = allTools.find((tool) => tool.name === "build_app");
    expect(original).toBeDefined();
    unifiedRegistry.register(original!, {
      defer: false,
      tags: ["apps"],
      searchHint: "build an app",
      toolClass: "internal",
    });
    const ctx = {
      activeRuntimeBySession: new Map([["session", { provider: "local", model: "google/gemma-4-e4b" }]]),
      registry: unifiedRegistry,
      secretsStore: {} as ToolPluginContext["secretsStore"],
    } as ToolPluginContext;

    const produced = await core!.register(ctx);
    const surfaced = produced.find((tool) => tool.name === "build_app");
    const inAllTools = allTools.find((tool) => tool.name === "build_app");
    const entry = unifiedRegistry.getEntry("build_app");

    expect(surfaced).toBe(inAllTools);
    expect(entry?.tool).toBe(inAllTools);
    expect(entry).toMatchObject({
      defer: false,
      tags: ["apps"],
      searchHint: "build an app",
      toolClass: "internal",
    });
  });
});
