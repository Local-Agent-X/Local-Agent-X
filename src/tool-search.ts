import type { Audience, ToolDefinition, ToolResult } from "./types.js";

interface RegistryEntry {
  tool: ToolDefinition;
  defer: boolean;
  tags: string[];
  searchHint: string;
}

/**
 * Canonical per-request tool resolver (AUDIT Cluster 11).
 *
 * Replaces the five drifting filter sets (CORE_TOOL_NAMES, OPERATOR_TOOLS,
 * BUILD_INTENT_TOOLS, EAGER_TOOLS, ToolDefinition.defer) with one function
 * that reads each tool's `audiences` field. See docs/tool-resolver-design.md.
 *
 * Behavior is keyed on audience:
 *  - "main-chat":     eager set for main-chat + keyword routing + literal-call detection
 *                     + build-intent strip-down when message matches
 *  - "spawned-agent": fixed eager set, no message inspection
 *  - "operator":      fixed eager set, no message inspection, no identity-tool intersection
 *  - "build-intent":  used internally by main-chat strip-down; callers shouldn't request directly
 *
 * Pure function. No I/O. Deterministic for a given (registry, request) pair.
 */

export interface ResolveRequest {
  audience: Audience;
  /** User message text. Only used when audience === "main-chat". */
  message?: string;
  /** Optional per-template tool restriction. Intersected as final pass for
   *  spawned-agent audience. Identity helpers (issue_*, agent_whoami,
   *  agent_team_list, agent_wakeup) are always preserved. */
  templateAllowedTools?: string[];
  /** Optional keyword router. Lets the caller (tool-filter.ts) inject the
   *  TOOL_KEYWORD_MAP without forcing the resolver to import it. Only used
   *  for main-chat. */
  keywordRouter?: (message: string, allTools: ToolDefinition[]) => Set<string>;
  /** Optional literal-tool-call detector. Same injection pattern as
   *  keywordRouter. Only used for main-chat. */
  literalCallDetector?: (message: string, allTools: ToolDefinition[]) => Set<string>;
  /** Optional build-intent test. Only used for main-chat. */
  buildIntentTest?: (message: string) => boolean;
}

const IDENTITY_TOOLS: ReadonlySet<string> = new Set([
  "issue_create", "issue_list", "issue_update", "issue_search",
  "issue_checkout", "issue_release", "issue_request_approval",
  "agent_whoami", "agent_team_list", "agent_wakeup",
]);

export function resolveToolsForRequest(
  req: ResolveRequest,
  all: ToolDefinition[],
): ToolDefinition[] {
  // Main-chat is the only audience that inspects the message.
  if (req.audience === "main-chat") {
    return resolveMainChat(req, all);
  }

  // Non-chat audiences: return everything tagged with this audience.
  let result = all.filter(t => t.audiences?.includes(req.audience));

  // Spawned-agent applies a per-template intersection if set, always
  // preserving the identity helpers (agent_whoami, issue_*, etc).
  if (req.audience === "spawned-agent" && req.templateAllowedTools && req.templateAllowedTools.length > 0) {
    const allowed = new Set(req.templateAllowedTools);
    result = result.filter(t => allowed.has(t.name) || IDENTITY_TOOLS.has(t.name));
  }

  return result;
}

function resolveMainChat(req: ResolveRequest, all: ToolDefinition[]): ToolDefinition[] {
  const msg = req.message ?? "";
  const literalCalls = req.literalCallDetector
    ? req.literalCallDetector(msg, all)
    : new Set<string>();

  // Build-intent strip-down. If the user message is "build me X" AND they
  // didn't paste a literal tool call, narrow to build-intent audience.
  // Literal calls always win — even on build-intent matches.
  if (req.buildIntentTest && req.buildIntentTest(msg) && literalCalls.size === 0) {
    return all.filter(t => t.audiences?.includes("build-intent"));
  }

  const included = new Set<string>();
  for (const t of all) {
    if (t.audiences?.includes("main-chat")) included.add(t.name);
  }
  for (const name of literalCalls) included.add(name);
  if (req.keywordRouter) {
    for (const name of req.keywordRouter(msg, all)) included.add(name);
  }

  return all.filter(t => included.has(t.name));
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

      // Exact name match dominates. Without this, a query like
      // "primal_run_build_plan exact call" lost to memory_recall because
      // "recall" contains "call" — substring matches were stacking up
      // higher than a direct name hit on the target tool.
      if (queryLower === nameLower) score += 100;
      for (const word of words) {
        if (word === nameLower) score += 50;     // exact-word == full tool name
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
