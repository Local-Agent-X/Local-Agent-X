import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ToolDefinition } from "../src/types.js";
import { augmentFromToolSearch } from "../src/canonical-loop/chat-tool-dispatcher.js";

// Mock the runtime so registerToolsForOp is a spy we can assert on.
vi.mock("../src/canonical-loop/runtime.js", () => ({
  registerToolsForOp: vi.fn(),
}));

// Mock the unified registry to a controllable Map. Tests inject the tools
// they want the registry to know about before running augmentFromToolSearch.
const fakeRegistry = new Map<string, ToolDefinition>();
vi.mock("../src/tools/registry.js", () => ({
  unifiedRegistry: {
    get: (name: string) => fakeRegistry.get(name),
  },
}));

import { registerToolsForOp } from "../src/canonical-loop/runtime.js";

function mkTool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} description`,
    parameters: { type: "object", properties: {} },
    async execute() { return { content: "" }; },
  };
}

beforeEach(() => {
  fakeRegistry.clear();
  (registerToolsForOp as unknown as ReturnType<typeof vi.fn>).mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("augmentFromToolSearch", () => {
  it("does nothing when content isn't a JSON array", () => {
    const toolMap = new Map<string, ToolDefinition>();
    augmentFromToolSearch("No tools matched the query.", "op-1", toolMap);
    expect(toolMap.size).toBe(0);
    expect(registerToolsForOp).not.toHaveBeenCalled();
  });

  it("ignores malformed JSON without throwing", () => {
    const toolMap = new Map<string, ToolDefinition>();
    augmentFromToolSearch("[not valid json", "op-1", toolMap);
    expect(toolMap.size).toBe(0);
    expect(registerToolsForOp).not.toHaveBeenCalled();
  });

  it("adds registry-known tools to toolMap and re-registers the op", () => {
    fakeRegistry.set("protocol_curate", mkTool("protocol_curate"));
    fakeRegistry.set("protocol_stats", mkTool("protocol_stats"));

    const toolMap = new Map<string, ToolDefinition>();
    toolMap.set("read", mkTool("read"));

    const matches = JSON.stringify([
      { name: "protocol_curate", description: "...", parameters: {} },
      { name: "protocol_stats", description: "...", parameters: {} },
    ]);
    augmentFromToolSearch(matches, "op-abc", toolMap);

    expect(toolMap.has("protocol_curate")).toBe(true);
    expect(toolMap.has("protocol_stats")).toBe(true);
    expect(toolMap.has("read")).toBe(true);
    expect(registerToolsForOp).toHaveBeenCalledTimes(1);
    const [opId, registered] = (registerToolsForOp as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(opId).toBe("op-abc");
    const names = (registered as Array<{ name: string }>).map((t) => t.name).sort();
    expect(names).toEqual(["protocol_curate", "protocol_stats", "read"]);
  });

  it("skips tools already in toolMap (idempotent)", () => {
    fakeRegistry.set("protocol_curate", mkTool("protocol_curate"));

    const toolMap = new Map<string, ToolDefinition>();
    toolMap.set("protocol_curate", mkTool("protocol_curate"));

    const matches = JSON.stringify([{ name: "protocol_curate" }]);
    augmentFromToolSearch(matches, "op-1", toolMap);

    expect(registerToolsForOp).not.toHaveBeenCalled();
  });

  it("skips matched names not present in the registry", () => {
    const toolMap = new Map<string, ToolDefinition>();
    const matches = JSON.stringify([{ name: "totally_made_up_tool" }]);
    augmentFromToolSearch(matches, "op-1", toolMap);

    expect(toolMap.size).toBe(0);
    expect(registerToolsForOp).not.toHaveBeenCalled();
  });

  it("converts ToolDefinition.parameters → ToolDescriptor.inputSchema", () => {
    const params = { type: "object", properties: { name: { type: "string" } }, required: ["name"] };
    fakeRegistry.set("custom_tool", { ...mkTool("custom_tool"), parameters: params });

    const toolMap = new Map<string, ToolDefinition>();
    const matches = JSON.stringify([{ name: "custom_tool" }]);
    augmentFromToolSearch(matches, "op-1", toolMap);

    const [, registered] = (registerToolsForOp as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const descriptor = (registered as Array<{ name: string; inputSchema: unknown }>)
      .find((t) => t.name === "custom_tool");
    expect(descriptor?.inputSchema).toEqual(params);
  });

  it("handles partial matches (some in registry, some not)", () => {
    fakeRegistry.set("protocol_curate", mkTool("protocol_curate"));

    const toolMap = new Map<string, ToolDefinition>();
    const matches = JSON.stringify([
      { name: "protocol_curate" },
      { name: "ghost_tool" },
    ]);
    augmentFromToolSearch(matches, "op-1", toolMap);

    expect(toolMap.has("protocol_curate")).toBe(true);
    expect(toolMap.has("ghost_tool")).toBe(false);
    expect(registerToolsForOp).toHaveBeenCalledTimes(1);
  });

  it("ignores entries without a string name", () => {
    fakeRegistry.set("real_tool", mkTool("real_tool"));
    const toolMap = new Map<string, ToolDefinition>();
    const matches = JSON.stringify([
      { description: "no name field" },
      { name: 42 },
      null,
      { name: "real_tool" },
    ]);
    augmentFromToolSearch(matches, "op-1", toolMap);

    expect(toolMap.has("real_tool")).toBe(true);
    expect(toolMap.size).toBe(1);
  });
});
