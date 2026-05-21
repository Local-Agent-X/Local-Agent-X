/**
 * Unified tool registry — single source of truth for every tool the system
 * knows about. Closes DRY-AUDIT.md F2 (part 1) by collapsing the three
 * pre-existing registries (registry-build.ts allTools[], tool-search.ts
 * ToolRegistry class, packages/arikernel/tool-executors ExecutorRegistry)
 * into one indexed store.
 *
 * Two consumer views read from this same store:
 *
 *   - Chat-path: name-keyed lookup for prompt assembly, tool_search,
 *     audience filtering, and dispatch (see src/tool-search.ts re-export).
 *   - AriKernel: toolClass-keyed filter via getByToolClass(); the
 *     ExecutorRegistry inside the arikernel package is the matching
 *     in-package store (no longer self-constructing) and the SAX side
 *     wires the two together at boot.
 *
 * MCP tools register here directly during boot (see bootstrap-tools.ts) —
 * no more catch-up dedup pass after buildToolRegistry().
 */
import type { ToolClass } from "@arikernel/core";
import type { ToolDefinition } from "../types.js";

export interface RegistryEntry {
  tool: ToolDefinition;
  defer: boolean;
  tags: string[];
  searchHint: string;
  /** AriKernel tool class, when this tool participates in the kernel pipeline. */
  toolClass?: ToolClass;
  /** MCP server that contributed this tool, when sourced from MCP. */
  mcpSource?: string;
}

export interface RegisterOptions {
  defer?: boolean;
  tags?: string[];
  searchHint?: string;
  toolClass?: ToolClass;
  mcpSource?: string;
}

export interface DeferredToolListing {
  name: string;
  description: string;
  tags: string[];
  searchHint: string;
}

export class UnifiedToolRegistry {
  private tools = new Map<string, RegistryEntry>();

  /**
   * Register a tool. If a tool of the same name exists, it is replaced
   * (last write wins). The replacement is deliberate — bootstrap and
   * MCP reload both expect to overwrite stale entries cleanly. Callers
   * that want first-write-wins should check `get(name)` first.
   */
  register(tool: ToolDefinition, opts?: RegisterOptions): void {
    this.tools.set(tool.name, {
      tool,
      defer: opts?.defer ?? false,
      tags: opts?.tags ?? [],
      searchHint: opts?.searchHint ?? "",
      toolClass: opts?.toolClass,
      mcpSource: opts?.mcpSource,
    });
  }

  /** Remove a tool by name. Returns true if something was removed. */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /** Lookup a tool's executable definition by name. */
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)?.tool;
  }

  /** Lookup the full registry entry (definition + metadata) by name. */
  getEntry(name: string): RegistryEntry | undefined {
    return this.tools.get(name);
  }

  /** All registered tool definitions, in insertion order. */
  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((e) => e.tool);
  }

  /** Tools that have at least one audience (visible in per-request schema). */
  getEagerTools(): ToolDefinition[] {
    const out: ToolDefinition[] = [];
    for (const entry of this.tools.values()) {
      if (!entry.defer) out.push(entry.tool);
    }
    return out;
  }

  /** Deferred tools — only surfaced via `tool_search`. */
  getDeferredTools(): DeferredToolListing[] {
    const out: DeferredToolListing[] = [];
    for (const e of this.tools.values()) {
      if (e.defer) {
        out.push({
          name: e.tool.name,
          description: e.tool.description,
          tags: e.tags,
          searchHint: e.searchHint,
        });
      }
    }
    return out;
  }

  /**
   * AriKernel view — tools tagged with the given `toolClass`. The kernel's
   * own ExecutorRegistry holds the live `ToolExecutor` instances; this
   * view is the source of truth for "which tools belong to which class"
   * (used for filtering/inspection and for SAX-side mirroring at boot).
   */
  getByToolClass(toolClass: ToolClass): ToolDefinition[] {
    const out: ToolDefinition[] = [];
    for (const entry of this.tools.values()) {
      if (entry.toolClass === toolClass) out.push(entry.tool);
    }
    return out;
  }

  /** All tools that came from the named MCP server (or any MCP server when omitted). */
  getMcpTools(serverName?: string): ToolDefinition[] {
    const out: ToolDefinition[] = [];
    for (const entry of this.tools.values()) {
      if (!entry.mcpSource) continue;
      if (serverName && entry.mcpSource !== serverName) continue;
      out.push(entry.tool);
    }
    return out;
  }

  /**
   * Keyword search — surfaced by the `tool_search` tool so the model can
   * discover deferred tools at turn time. Scoring rationale: exact name
   * match dominates so a query like "primal_run_build_plan exact call"
   * doesn't get beaten by `memory_recall` (which contains "call" via
   * "recall"). Substring matches stack below the exact-hit floor.
   */
  search(query: string, maxResults = 5): ToolDefinition[] {
    const queryLower = query.toLowerCase().trim();
    const words = queryLower.split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];

    const scored: { tool: ToolDefinition; score: number }[] = [];

    for (const entry of this.tools.values()) {
      let score = 0;
      const nameLower = entry.tool.name.toLowerCase();
      const descLower = entry.tool.description.toLowerCase();
      const tagsLower = entry.tags.map((t) => t.toLowerCase());
      const hintLower = entry.searchHint.toLowerCase();

      if (queryLower === nameLower) score += 100;
      for (const word of words) {
        if (word === nameLower) score += 50;
        else if (nameLower.includes(word)) score += 3;
        if (tagsLower.some((t) => t === word)) score += 5;
        else if (tagsLower.some((t) => t.includes(word))) score += 2;
        if (hintLower.includes(word)) score += 2;
        if (descLower.includes(word)) score += 1;
      }

      if (score > 0) scored.push({ tool: entry.tool, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, maxResults).map((s) => s.tool);
  }

  /** Test-only helper. Drops every entry. Production code never calls this. */
  _resetForTesting(): void {
    this.tools.clear();
  }
}

/**
 * Process-wide singleton. Both `src/tools/registry-build.ts` and
 * `src/tool-search.ts` consume this instance — there is no second
 * `new UnifiedToolRegistry()` anywhere outside this file.
 */
export const unifiedRegistry: UnifiedToolRegistry = new UnifiedToolRegistry();
