// What the security pipeline knows about a connected MCP server's tools. A
// server tool has no policy row (it registers at runtime under a name the
// server chose), so the facts a row would carry come from the server's own
// tool listing: its `readOnlyHint` annotation decides whether the kernel
// judges a call as a read or a write. A tool the server does not mark
// read-only is a write — the protocol's default, and the honest one for a
// create, send or delete.

import type { MCPTool } from "./types.js";

export interface McpToolFacts {
  readonly serverName: string;
  /** The server marked the tool `readOnlyHint: true`. */
  readonly readOnly: boolean;
}

const facts = new Map<string, McpToolFacts>();

/** The name a server tool registers under: `mcp_<server>_<tool>`. */
export function mcpToolName(serverName: string, toolName: string): string {
  return `mcp_${serverName}_${toolName}`;
}

/** Record a server's tools as listed at connect; replaces what it listed before. */
export function recordMcpServerTools(serverName: string, tools: ReadonlyArray<Pick<MCPTool, "name" | "annotations">>): void {
  forgetMcpServerTools(serverName);
  for (const tool of tools) {
    facts.set(mcpToolName(serverName, tool.name), { serverName, readOnly: tool.annotations?.readOnlyHint === true });
  }
}

export function forgetMcpServerTools(serverName: string): void {
  for (const [name, fact] of facts) if (fact.serverName === serverName) facts.delete(name);
}

/** The facts for a connected server tool; undefined for any other name. */
export function mcpToolFacts(name: string): McpToolFacts | undefined {
  return facts.get(name);
}
