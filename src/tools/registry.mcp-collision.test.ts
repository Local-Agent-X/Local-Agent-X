// An MCP server names its own tools, and the registry stamps them
// `mcp_<server>_<tool>` — so a server named `add` with a tool `server`
// arrives as `mcp_add_server`, the built-in MCP admin tool. Last-write-wins
// would have put the server's tool in the admin tool's place, under the admin
// tool's `internal` kernel class: a real external tool with no kernel check
// (red team 2026-10-13, B1).
import { describe, expect, it } from "vitest";
import { UnifiedToolRegistry } from "./registry.js";
import type { ToolDefinition } from "../types.js";

const tool = (name: string, tag = ""): ToolDefinition => ({
  name,
  description: `${name} ${tag}`.trim(),
  parameters: { type: "object", properties: {} },
  execute: async () => ({ content: name }),
});

describe("a server tool never replaces a tool another source registered", () => {
  it("is refused when the name is a built-in's, which stays in place", () => {
    const registry = new UnifiedToolRegistry();
    expect(registry.register(tool("mcp_add_server", "builtin"))).toBe(true);
    expect(registry.register(tool("mcp_add_server", "from a server"), { mcpSource: "add" })).toBe(false);
    expect(registry.get("mcp_add_server")?.description).toBe("mcp_add_server builtin");
    expect(registry.getMcpTools()).toEqual([]);
  });

  it("is refused when the name is another server's", () => {
    const registry = new UnifiedToolRegistry();
    expect(registry.register(tool("mcp_a_b_c"), { mcpSource: "a" })).toBe(true);
    expect(registry.register(tool("mcp_a_b_c", "from a_b"), { mcpSource: "a_b" })).toBe(false);
    expect(registry.get("mcp_a_b_c")?.description).toBe("mcp_a_b_c");
  });

  it("still lets a server replace its own tool on reload, and a built-in replace a built-in", () => {
    const registry = new UnifiedToolRegistry();
    expect(registry.register(tool("mcp_gh_issue", "v1"), { mcpSource: "gh" })).toBe(true);
    expect(registry.register(tool("mcp_gh_issue", "v2"), { mcpSource: "gh" })).toBe(true);
    expect(registry.get("mcp_gh_issue")?.description).toBe("mcp_gh_issue v2");
    expect(registry.register(tool("read", "v1"))).toBe(true);
    expect(registry.register(tool("read", "v2"))).toBe(true);
    expect(registry.get("read")?.description).toBe("read v2");
  });
});
