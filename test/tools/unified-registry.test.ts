import { describe, it, expect, beforeEach } from "vitest";
import { UnifiedToolRegistry } from "../../src/tools/registry.js";
import type { ToolDefinition, ToolResult } from "../../src/types.js";

// Regression test for DRY-AUDIT.md F2 (sub-commit 2C.1) — the chat-path
// registry, the tool-search registry, and the AriKernel ExecutorRegistry
// all read from the same store now. A single registration must be visible
// to all three view-shapes (name lookup, deferred listing, toolClass
// filter). This test asserts the registry surface, independent of the
// downstream consumer wiring.

function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} test tool`,
    parameters: { type: "object", properties: {} },
    async execute(): Promise<ToolResult> {
      return { content: `${name} ran` };
    },
  };
}

describe("UnifiedToolRegistry — F2 single-source store", () => {
  let registry: UnifiedToolRegistry;

  beforeEach(() => {
    registry = new UnifiedToolRegistry();
  });

  it("a tool registered with toolClass='shell' is visible to BOTH the chat-path and the AriKernel view", () => {
    const tool = makeTool("bash");
    registry.register(tool, { toolClass: "shell", tags: ["shell"], searchHint: "run a command" });

    // Chat-path view — name-keyed lookup.
    expect(registry.get("bash")).toBe(tool);

    // AriKernel view — toolClass-keyed filter (this is the
    // "ExecutorRegistry-as-view" surface from F2 part 1).
    const shellTools = registry.getByToolClass("shell");
    expect(shellTools).toHaveLength(1);
    expect(shellTools[0]).toBe(tool);

    // toolClass filter is exact — wrong class returns nothing.
    expect(registry.getByToolClass("file")).toEqual([]);
  });

  it("MCP-sourced tools are tagged at registration time and surfaced via getMcpTools()", () => {
    const githubTool = makeTool("mcp_github_create_issue");
    const fsTool = makeTool("mcp_filesystem_read_file");
    registry.register(githubTool, { defer: true, mcpSource: "github" });
    registry.register(fsTool, { defer: true, mcpSource: "filesystem" });
    registry.register(makeTool("read"), { defer: false });

    expect(registry.getMcpTools()).toHaveLength(2);
    expect(registry.getMcpTools("github")).toEqual([githubTool]);
    expect(registry.getMcpTools("filesystem")).toEqual([fsTool]);
    expect(registry.getMcpTools("nonexistent")).toEqual([]);
  });

  it("deferred vs eager split — defer-tagged tools land in the deferred listing, others in eager", () => {
    const eagerTool = makeTool("eager_one");
    const deferredTool = makeTool("deferred_one");
    registry.register(eagerTool, { defer: false });
    registry.register(deferredTool, { defer: true, tags: ["util"], searchHint: "deferred sample" });

    expect(registry.getEagerTools()).toEqual([eagerTool]);
    const deferred = registry.getDeferredTools();
    expect(deferred).toHaveLength(1);
    expect(deferred[0]).toMatchObject({
      name: "deferred_one",
      tags: ["util"],
      searchHint: "deferred sample",
    });
  });

  it("re-registering a name overwrites — last write wins (matches MCP reload semantics)", () => {
    const v1 = makeTool("flaky_tool");
    const v2 = makeTool("flaky_tool");
    registry.register(v1);
    registry.register(v2);
    expect(registry.get("flaky_tool")).toBe(v2);
    expect(registry.getAll()).toHaveLength(1);
  });

  it("search() ranks exact name matches above substring noise", () => {
    registry.register(makeTool("memory_recall"), { searchHint: "recall stored memories" });
    registry.register(makeTool("primal_run_build_plan"), { searchHint: "execute a build plan" });
    const results = registry.search("primal_run_build_plan");
    expect(results[0].name).toBe("primal_run_build_plan");
  });
});
