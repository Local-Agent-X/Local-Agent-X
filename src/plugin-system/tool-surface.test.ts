import { afterEach, describe, expect, it } from "vitest";
import { classifyToolRisk } from "../autonomy/risk.js";
import { kernelClassForTool } from "../ari-kernel/tool-class-map.js";
import { isCommittingTool } from "../committing-tool-check.js";
import { checkToolLoops, createLoopState, NO_PROGRESS_LIMIT, noteToolResults } from "../agent-guards/loop-detection.js";
import { hasCapability } from "../tool-registry.js";
import { isMutationTool, isProgressTool } from "../tool-mutation-check.js";
import { ToolPolicy } from "../tool-policy/index.js";
import { createToolSearchTool } from "../tools/tool-search.js";
import { UnifiedToolRegistry } from "../tools/registry.js";
import type { ToolDefinition } from "../types.js";
import type { PluginManifest } from "./manifest.js";
import { PluginToolSurface } from "./tool-surface.js";

const surfaces: Array<{ surface: PluginToolSurface; owner: string }> = [];

function definition(name: string, execute?: ToolDefinition["execute"]): ToolDefinition {
  return {
    name,
    description: `External ${name}`,
    parameters: { type: "object", properties: {}, required: [] },
    execute: execute ?? (async () => ({ content: `${name} ran` })),
  };
}

function manifest(owner: string, names: string[]): PluginManifest {
  return {
    id: owner,
    name: owner,
    version: "1.0.0",
    description: "surface test",
    entryPoint: "index.mjs",
    tools: names,
    contributions: { tools: names },
  };
}

function setup(owner: string, names: string[], extraRules: Array<{ id: string; tool: string }> = []) {
  const registry = new UnifiedToolRegistry();
  const live: ToolDefinition[] = [];
  const policy = new ToolPolicy({
    defaultDecision: "deny",
    rules: [
      ...names.map((name) => ({ id: `allow-${name}`, tool: name, decision: "allow" as const, reason: "test" })),
      ...extraRules.map((rule) => ({ ...rule, decision: "allow" as const, reason: "test" })),
    ],
  });
  const surface = new PluginToolSurface(registry, live, policy);
  surfaces.push({ surface, owner });
  return { registry, live, surface };
}

afterEach(() => {
  for (const { surface, owner } of surfaces.splice(0)) surface.deactivate(owner);
});

describe("PluginToolSurface", () => {
  it("projects one deferred definition through registry, live tools, and tool_search", async () => {
    const owner = "weather-plugin";
    const { registry, live, surface } = setup(owner, ["weather_lookup"]);
    const prepared = surface.prepare(owner, manifest(owner, ["weather_lookup"]), {
      weather_lookup: definition("weather_lookup"),
    });
    expect(prepared).not.toBeNull();
    surface.activate(prepared!);

    expect(live.map((tool) => tool.name)).toEqual(["weather_lookup"]);
    expect(registry.get("weather_lookup")).toBe(live[0]);
    expect(registry.getDeferredTools().map((tool) => tool.name)).toContain("weather_lookup");
    const search = createToolSearchTool(registry);
    expect((await search.execute({ query: "weather_lookup" })).content).toContain("weather_lookup");
    expect(await live[0].execute({})).toEqual({ content: "weather_lookup ran" });
  });

  it("binds registered identity to content-free plugin bundle provenance", () => {
    const owner = "provenance-plugin";
    const { registry, surface } = setup(owner, ["provenance_action"]);
    const pluginManifest = manifest(owner, ["provenance_action"]);
    const module = { provenance_action: definition("provenance_action") };
    const first = surface.prepare(owner, pluginManifest, module, "a".repeat(64))!;
    surface.activate(first);
    const firstFingerprint = registry.getEntry("provenance_action")!.implementationFingerprint;
    surface.deactivate(owner);
    const second = surface.prepare(owner, pluginManifest, module, "b".repeat(64))!;
    surface.activate(second);
    const secondFingerprint = registry.getEntry("provenance_action")!.implementationFingerprint;

    expect(firstFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(secondFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(secondFingerprint).not.toBe(firstFingerprint);
    expect(secondFingerprint).not.toContain("b".repeat(64));
  });

  it("classifies external tools conservatively for kernel, autonomy, capability, and replay", () => {
    const owner = "risk-plugin";
    const { surface } = setup(owner, ["external_action"]);
    const prepared = surface.prepare(owner, manifest(owner, ["external_action"]), {
      external_action: definition("external_action"),
    })!;
    surface.activate(prepared);

    expect(kernelClassForTool("external_action")).toBe("shell");
    expect(classifyToolRisk("external_action")).toBe("shell");
    expect(hasCapability("external_action", "shell")).toBe(true);
    expect(hasCapability("external_action", "egress")).toBe(false);
    expect(isCommittingTool("external_action")).toBe(true);
    expect(isMutationTool("external_action")).toBe(true);
    expect(isProgressTool("external_action")).toBe(true);
    expect(prepared.tools[0].effect).toEqual({ class: "non-idempotent" });
    expect(prepared.tools[0].readOnly).toBeUndefined();
    expect(prepared.tools[0].concurrencySafe).toBeUndefined();
  });

  it("revokes stale wrappers and only removes definitions owned by the disabled plugin", async () => {
    const owner = "revocable-plugin";
    const { registry, live, surface } = setup(owner, ["revocable_action"]);
    const prepared = surface.prepare(owner, manifest(owner, ["revocable_action"]), {
      revocable_action: definition("revocable_action"),
    })!;
    surface.activate(prepared);
    const stale = prepared.tools[0];
    surface.deactivate(owner);

    expect(registry.get("revocable_action")).toBeUndefined();
    expect(live).toEqual([]);
    expect(await stale.execute({})).toEqual(expect.objectContaining({ status: "blocked", isError: true }));
    expect(kernelClassForTool("revocable_action")).toBeUndefined();
    expect(isMutationTool("revocable_action")).toBe(false);
    expect(isProgressTool("revocable_action")).toBe(false);
  });

  it("resets the no-progress guard only while the plugin mutation is active", () => {
    const owner = "loop-plugin";
    const { surface } = setup(owner, ["loop_action"]);
    const prepared = surface.prepare(owner, manifest(owner, ["loop_action"]), {
      loop_action: definition("loop_action"),
    })!;
    surface.activate(prepared);
    const activeState = createLoopState();
    activeState.iterationsSinceProgress = NO_PROGRESS_LIMIT - 1;
    const activeVerdict = checkToolLoops(
      [{ name: "loop_action", arguments: "{}" }],
      activeState,
      { modelTier: "strong" },
    );
    expect(activeVerdict.abort).toBe(false);
    expect(activeState.iterationsSinceProgress).toBe(0);
    const observed = noteToolResults(
      [{ name: "loop_action", arguments: "{}" }],
      activeState,
      [{ content: "plugin mutation completed", status: "ok" }],
      { armWorkerPivot: true },
    );
    expect(observed.successfulMutation).toBe(true);
    expect(observed.pendingPivot).toBeNull();

    surface.deactivate(owner);
    const inactiveState = createLoopState();
    inactiveState.iterationsSinceProgress = NO_PROGRESS_LIMIT - 1;
    const inactiveVerdict = checkToolLoops(
      [{ name: "loop_action", arguments: "{}" }],
      inactiveState,
      { modelTier: "strong" },
    );
    expect(inactiveVerdict.abort).toBe(true);
  });

  it("rejects malformed, cyclic, and non-serializable parameter schemas before reservation", () => {
    const owner = "schema-plugin";
    const { surface } = setup(owner, ["schema_action"]);
    const attempt = (parameters: unknown) => surface.prepare(owner, manifest(owner, ["schema_action"]), {
      schema_action: { ...definition("schema_action"), parameters } as ToolDefinition,
    });

    expect(() => attempt({ type: "object", properties: "bad", required: [] })).toThrow(/properties/);
    expect(() => attempt({ type: "object", properties: {}, required: "bad" })).toThrow(/required/);
    expect(() => attempt({
      type: "object",
      properties: { items: { type: "array", items: { type: "unsupported" } } },
      required: ["items"],
    })).toThrow(/supported JSON-schema type/);
    expect(() => attempt({
      type: "object",
      properties: { present: { type: "string" } },
      required: ["missing"],
    })).toThrow(/declared properties/);
    expect(() => attempt({
      type: "object",
      properties: { mode: { type: "string", enum: ["same", "same"] } },
      required: [],
    })).toThrow(/unique/);
    expect(() => attempt({
      type: "object",
      properties: { value: { type: "string", default: () => "bad" } },
      required: [],
    })).toThrow(/JSON-serializable/);
    expect(() => attempt({ type: "object", properties: {}, required: [], oneOf: [] })).toThrow(/supported/);

    const cyclic: Record<string, unknown> = { type: "object", properties: {}, required: [] };
    (cyclic.properties as Record<string, unknown>).self = cyclic;
    expect(() => attempt(cyclic)).toThrow(/cycle/);

    const valid = attempt({
      type: "object",
      properties: {
        request: {
          type: "object",
          properties: {
            names: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
            mode: { type: "string", enum: ["safe", "fast"] },
          },
          required: ["names"],
          additionalProperties: false,
        },
      },
      required: ["request"],
      additionalProperties: false,
    });
    expect(valid).not.toBeNull();
    surface.abort(valid!);
  });

  it("rejects glob-only policy coverage, unsafe names, collisions, and export drift", () => {
    const registry = new UnifiedToolRegistry();
    const live: ToolDefinition[] = [definition("existing_tool")];
    registry.register(live[0]);
    const globPolicy = new ToolPolicy({
      defaultDecision: "deny",
      rules: [{ id: "plugin-glob", tool: "plugin_*", decision: "allow", reason: "too broad" }],
    });
    const globSurface = new PluginToolSurface(registry, live, globPolicy);
    expect(() => globSurface.prepare("glob", manifest("glob", ["plugin_action"]), {
      plugin_action: definition("plugin_action"),
    })).toThrow(/exact live policy rule/);

    const { surface } = setup("invalid", ["bad-name", "existing_tool", "declared_tool"]);
    expect(() => surface.prepare("invalid", manifest("invalid", ["bad-name"]), {
      "bad-name": definition("bad-name"),
    })).toThrow(/unsafe/);
    expect(() => surface.prepare("invalid", manifest("invalid", ["declared_tool"]), {
      different_export: definition("different_export"),
    })).toThrow(/exactly match/);

    const collisionSurface = new PluginToolSurface(
      registry,
      live,
      new ToolPolicy({
        defaultDecision: "deny",
        rules: [{ id: "exact", tool: "existing_tool", decision: "allow", reason: "test" }],
      }),
    );
    expect(() => collisionSurface.prepare("invalid", manifest("invalid", ["existing_tool"]), {
      existing_tool: definition("existing_tool"),
    })).toThrow(/collides/);
  });

  it("reserves names before persistence so concurrent plugins cannot race", () => {
    const { surface } = setup("first", ["shared_action"]);
    const first = surface.prepare("first", manifest("first", ["shared_action"]), {
      shared_action: definition("shared_action"),
    })!;
    expect(() => surface.prepare("second", manifest("second", ["shared_action"]), {
      shared_action: definition("shared_action"),
    })).toThrow(/collides/);
    expect(() => surface.prepare("first", manifest("first", ["different_action"]), {
      different_action: definition("different_action"),
    })).toThrow(/already owns or reserves/);
    surface.abort(first);
    expect(surface.prepare("second", manifest("second", ["shared_action"]), {
      shared_action: definition("shared_action"),
    })).not.toBeNull();
  });

  it("does not unregister a definition that another owner replaced", () => {
    const owner = "original-owner";
    const { registry, surface } = setup(owner, ["owned_action"]);
    const prepared = surface.prepare(owner, manifest(owner, ["owned_action"]), {
      owned_action: definition("owned_action"),
    })!;
    surface.activate(prepared);
    const replacement = definition("owned_action");
    registry.register(replacement);

    surface.deactivate(owner);
    expect(registry.get("owned_action")).toBe(replacement);
  });

  it("rolls every authority surface back when multi-tool activation fails partway", async () => {
    class FailingRegistry extends UnifiedToolRegistry {
      private registrations = 0;
      private fail = true;
      override register(tool: ToolDefinition, options?: Parameters<UnifiedToolRegistry["register"]>[1]): void {
        this.registrations += 1;
        if (this.fail && this.registrations === 2) {
          this.fail = false;
          throw new Error("injected second registration failure");
        }
        super.register(tool, options);
      }
    }

    const owner = "atomic-owner";
    const names = ["atomic_first", "atomic_second"];
    const registry = new FailingRegistry();
    const live: ToolDefinition[] = [];
    const policy = new ToolPolicy({
      defaultDecision: "deny",
      rules: names.map((name) => ({
        id: `allow-${name}`,
        tool: name,
        decision: "allow" as const,
        reason: "test",
      })),
    });
    const surface = new PluginToolSurface(registry, live, policy);
    surfaces.push({ surface, owner });
    const module = {
      atomic_first: definition("atomic_first"),
      atomic_second: definition("atomic_second"),
    };
    const prepared = surface.prepare(owner, manifest(owner, names), module)!;

    expect(() => surface.activate(prepared)).toThrow("injected second registration failure");
    expect(live).toEqual([]);
    for (const [index, name] of names.entries()) {
      expect(registry.get(name)).toBeUndefined();
      expect(kernelClassForTool(name)).toBeUndefined();
      expect(isCommittingTool(name)).toBe(false);
      expect(isMutationTool(name)).toBe(false);
      expect(isProgressTool(name)).toBe(false);
      expect(await prepared.tools[index].execute({})).toEqual(expect.objectContaining({
        status: "blocked",
        isError: true,
      }));
    }

    const retry = surface.prepare(owner, manifest(owner, names), module)!;
    expect(() => surface.activate(retry)).not.toThrow();
    expect(live).toEqual(retry.tools);
    expect(await retry.tools[1].execute({})).toEqual({ content: "atomic_second ran" });
  });
});
