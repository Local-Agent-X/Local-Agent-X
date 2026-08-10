/**
 * Contract tests for the delegated-worker toolset chooser.
 *
 * The chooser resolves from the live unifiedRegistry singleton (the one
 * source of truth — no second registry is ever constructed here). Each test
 * registers only the tools it needs and unregisters them afterwards, so the
 * registry's contents are exactly what the test declares.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Audience, ToolDefinition } from "../../types.js";
import { unifiedRegistry } from "../../tools/registry.js";
import { delegatedToolsetForOp, type DelegatedOpLane } from "./delegated-toolset.js";

const LANES: readonly DelegatedOpLane[] = ["interactive", "build", "background"];
const registered: string[] = [];

function mkTool(name: string, audiences: Audience[]): ToolDefinition {
  return {
    name,
    description: `test tool ${name}`,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: "ok" }),
    audiences,
  };
}

function registerAll(names: string[], audiences: Audience[] = ["spawned-agent"]): void {
  for (const name of names) {
    unifiedRegistry.register(mkTool(name, audiences));
    registered.push(name);
  }
}

afterEach(() => {
  for (const name of registered.splice(0)) unifiedRegistry.unregister(name);
});

describe("delegatedToolsetForOp", () => {
  it("keeps the read/web/search core the spawned-agent audience carries", () => {
    const core = ["read", "glob", "grep", "web_search", "web_fetch", "tool_search", "view_image"];
    registerAll(core);

    const names = delegatedToolsetForOp("interactive").map((t) => t.name);

    for (const name of core) expect(names).toContain(name);
  });

  it("never includes spawn/mutation tools, even when the registry tags them spawned-agent", () => {
    const denied = [
      "op_submit", "op_submit_async", "op_submit_batch", "agent_spawn",
      "mission_schedule_create", "mission_schedule_update",
      "write", "edit", "bash", "ari_file", "ari_shell", "process_start",
      "edit_lines", "multi_edit", "bulk_replace", "delete_file",
    ];
    // Adversarial registration: tag every denied tool with the spawned-agent
    // audience so only the subtraction belt can keep it out.
    registerAll(["read", ...denied]);

    for (const lane of LANES) {
      const names = new Set(delegatedToolsetForOp(lane).map((t) => t.name));
      expect(names).toContain("read");
      for (const name of denied) expect(names).not.toContain(name);
    }
  });

  it("returns the same belt for all three lanes in this phase", () => {
    registerAll(["read", "grep", "web_fetch", "tool_search", "op_status"]);

    const [interactive, build, background] = LANES.map((lane) =>
      delegatedToolsetForOp(lane).map((t) => t.name).sort(),
    );

    expect(build).toEqual(interactive);
    expect(background).toEqual(interactive);
  });

  it("skips tools absent from the registry instead of fabricating them", () => {
    registerAll(["read", "grep"]); // no web_search/web_fetch registered

    const tools = delegatedToolsetForOp("background");
    const names = tools.map((t) => t.name);

    expect(names.sort()).toEqual(["grep", "read"]);
    // Every returned definition is the registry's own live instance, not a
    // fabricated stand-in (fingerprints downstream depend on identity).
    for (const tool of tools) expect(unifiedRegistry.get(tool.name)).toBe(tool);
  });

  it("excludes tools not tagged for the spawned-agent audience", () => {
    registerAll(["read"]);
    registerAll(["screen_capture", "sidebar_pin"], ["main-chat"]);

    const names = delegatedToolsetForOp("interactive").map((t) => t.name);

    expect(names).toContain("read");
    expect(names).not.toContain("screen_capture");
    expect(names).not.toContain("sidebar_pin");
  });
});
