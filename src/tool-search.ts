import type { ToolDefinition, ToolResult } from "./types.js";

interface RegistryEntry {
  tool: ToolDefinition;
  defer: boolean;
  tags: string[];
  searchHint: string;
}

export const toolSearchEnhancements = {
  category: "system" as const,
  tags: ["search", "find", "tool", "discover"],
  readOnly: true,
  concurrencySafe: true,
  defer: false,
};

export class ToolRegistry {
  private tools = new Map<string, RegistryEntry>();

  register(
    tool: ToolDefinition,
    opts?: { defer?: boolean; tags?: string[]; searchHint?: string },
  ): void {
    this.tools.set(tool.name, {
      tool,
      defer: opts?.defer ?? false,
      tags: opts?.tags ?? [],
      searchHint: opts?.searchHint ?? "",
    });
  }

  getEagerTools(): ToolDefinition[] {
    const result: ToolDefinition[] = [];
    for (const entry of this.tools.values()) {
      if (!entry.defer) result.push(entry.tool);
    }
    return result;
  }

  getDeferredTools(): { name: string; description: string; tags: string[]; searchHint: string }[] {
    const out: { name: string; description: string; tags: string[]; searchHint: string }[] = [];
    for (const e of this.tools.values()) {
      if (e.defer) out.push({
        name: e.tool.name, description: e.tool.description,
        tags: e.tags, searchHint: e.searchHint,
      });
    }
    return out;
  }

  search(query: string, maxResults = 5): ToolDefinition[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];

    const scored: { tool: ToolDefinition; score: number }[] = [];

    for (const entry of this.tools.values()) {
      let score = 0;
      const nameLower = entry.tool.name.toLowerCase();
      const descLower = entry.tool.description.toLowerCase();
      const tagsLower = entry.tags.map((t) => t.toLowerCase());
      const hintLower = entry.searchHint.toLowerCase();

      for (const word of words) {
        if (nameLower.includes(word)) score += 3;
        if (tagsLower.some((t) => t.includes(word))) score += 2;
        if (hintLower.includes(word)) score += 2;
        if (descLower.includes(word)) score += 1;
      }

      if (score > 0) scored.push({ tool: entry.tool, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, maxResults).map((s) => s.tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)?.tool;
  }

  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((e) => e.tool);
  }
}

export function createToolSearchTool(registry: ToolRegistry): ToolDefinition {
  return {
    name: "tool_search",
    description:
      "Search for available tools by keyword. Returns matching tool schemas " +
      "so they can be used in subsequent turns. Use when you need a capability " +
      "not covered by the currently loaded tools.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Keywords to match against tool names, tags, and descriptions",
        },
        max_results: {
          type: "number",
          description: "Maximum results to return (default 5)",
        },
      },
      required: ["query"],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const query = String(args.query ?? "");
      const max = typeof args.max_results === "number" ? args.max_results : 5;
      const matches = registry.search(query, max);

      if (matches.length === 0) {
        return { content: "No tools matched the query." };
      }

      const results = matches.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }));

      return { content: JSON.stringify(results, null, 2) };
    },
  };
}
