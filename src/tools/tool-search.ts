import type { Audience, ToolDefinition, ToolResult } from "../types.js";
import { UnifiedToolRegistry } from "./registry.js";

/**
 * Canonical per-request tool resolver.
 *
 * One function that reads each tool's `audiences` field. Audience mapping
 * lives in src/tools/audience-map.ts.
 *
 * Behavior is keyed on audience:
 *  - "main-chat":     eager set for main-chat + keyword routing + literal-call detection
 *                     + build-intent strip-down when message matches
 *  - "spawned-agent": fixed eager set, no message inspection
 *  - "operator":      fixed eager set, no message inspection, no identity-tool intersection
 *  - "build-intent":  used internally by main-chat strip-down; callers shouldn't request directly
 *
 * Deterministic for a given (registry, request) pair. The only non-pure step is
 * the availability gate below: a tool may declare an `available()` predicate
 * that inspects live machine state (see isToolAvailable).
 *
 * WHERE THE AVAILABILITY GATE DOES *NOT* RUN — read this before assuming it is
 * universal. Three production paths reach the model without passing through
 * resolveToolsForRequest()/filterAvailableTools(), all of them fail-OPEN and all
 * of them unchanged from before the gate existed:
 *
 *  1. The bridge channels. selectTools() in
 *     src/agent-request/prepare-request/tool-selection.ts takes
 *     `if (isBridge) tools = input.bridgeTools` and never calls this resolver,
 *     so a Telegram/WhatsApp turn ships its bridge tool set ungated.
 *  2. Post-gate re-derivation on the chat path. That same function re-derives
 *     its result from the RAW `allAgentTools` after the gate has run (the RAG
 *     union, the provider tool cap, the tool_search re-add, the product-build
 *     route), so an unavailable tool can be added back into the schema.
 *  3. Keyword search. UnifiedToolRegistry.search() — the body of the
 *     `tool_search` tool below — scores the whole store, so a hidden tool
 *     remains findable by name. That one is the deliberate recovery path; see
 *     the docstring on search() in src/tools/registry.ts.
 *
 * In every case the model gets a tool that cannot work and receives that tool's
 * own explicit error, which is strictly better than the failure this mechanism
 * exists to prevent (a tool that works being silently invisible). Narrowing any
 * of them would turn a fail-open path fail-closed and is a separate decision,
 * not a bug fix.
 */

export interface ResolveRequest {
  audience: Audience;
  /** User message text. Only used when audience === "main-chat". */
  message?: string;
  /** Optional per-template tool restriction. Intersected as final pass for
   *  spawned-agent audience. Always-on helpers (issue_*, agent_whoami,
   *  agent_team_list, agent_wakeup, task_* planning tools) are preserved
   *  regardless of the allow-list — see ALWAYS_ON_TOOLS. */
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

const ALWAYS_ON_TOOLS: ReadonlySet<string> = new Set([
  "issue_create", "issue_list", "issue_update", "issue_search",
  "issue_checkout", "issue_release", "issue_request_approval",
  "agent_whoami", "agent_team_list", "agent_wakeup",
  // Every agent on a project can read and update the shared project brief.
  "project_brief_read", "project_brief_update",
  // Planning/bookkeeping: the open-steps completion gate (canonical-loop)
  // seeds and enforces a step plan on every worker run, so the task tools
  // ride along regardless of how narrow the template's allow-list is. They
  // mutate nothing but ~/.lax/tasks.json — not a capability escalation.
  "task_create", "task_update", "task_list", "task_get",
]);

/**
 * Availability gate for one tool. See ToolDefinition.available in src/types.ts.
 *
 * Every branch that isn't an explicit `false` from a predicate that ran cleanly
 * returns TRUE. Absent predicate → available. Predicate throws → available (and
 * the throw is contained here, so one bad predicate can't take down tool
 * resolution for every other tool). Non-boolean return → available.
 *
 * tool_search and ALWAYS_ON_TOOLS are checked BEFORE the predicate and can
 * never be hidden: tool_search is the escape hatch by which the model reaches a
 * deferred tool, and the always-on identity/coordination helpers are how a
 * spawned agent reports back. Losing either is unrecoverable at runtime.
 */
export function isToolAvailable(tool: ToolDefinition): boolean {
  if (tool.name === "tool_search" || ALWAYS_ON_TOOLS.has(tool.name)) return true;
  if (!tool.available) return true;
  try {
    return tool.available() !== false;
  } catch {
    return true;
  }
}

/**
 * Drop tools whose availability predicate says they cannot work right now.
 * Shared by the request seam below and the deferred-tool manifest inputs
 * (build-system-prompt.ts) so a hidden tool can't reappear by name there.
 *
 * Cost, measured rather than assumed: a full pass over the real 84-tool
 * catalog is 0.62ms on this box, dominated by the three email predicates'
 * getSmtp/ImapConfig() reads of ~/.lax/email.json (~18µs per readFileSync,
 * several per call). Two passes per turn (resolver + manifest) ≈ 1.2ms against
 * a multi-second model call. DELIBERATELY NOT CACHED: a TTL cache would buy
 * back a fraction of a millisecond and pay for it with a window where a tool
 * the user just configured is still hidden — which is the exact invisible
 * failure this whole mechanism exists to prevent. If a future predicate is
 * genuinely expensive (network, spawn), it should memoize inside itself.
 */
export function filterAvailableTools(tools: ToolDefinition[]): ToolDefinition[] {
  return tools.filter(isToolAvailable);
}

export function resolveToolsForRequest(
  req: ResolveRequest,
  catalog: ToolDefinition[],
): ToolDefinition[] {
  // Availability gate runs first, for every audience — so a tool that can't
  // work never consumes a scarce slot in what THIS function returns. Fail-open
  // per tool (isToolAvailable). It is not a guarantee about the final schema:
  // selectTools() re-derives from the raw catalog downstream of here. See the
  // module docstring above for the three paths the gate does not cover.
  const all = filterAvailableTools(catalog);

  // Main-chat is the only audience that inspects the message.
  if (req.audience === "main-chat") {
    return resolveMainChat(req, all);
  }

  // Non-chat audiences: return everything tagged with this audience.
  let result = all.filter(t => t.audiences?.includes(req.audience));

  // Spawned-agent: the per-template allow-list defines the surface, and the
  // identity/coordination helpers (agent_whoami, issue_*, etc.) are always
  // included. Resolve from the full set — identity and most template tools
  // carry no spawned-agent audience tag, so filtering the audience-gated
  // subset would drop them and the agent would get neither.
  if (req.audience === "spawned-agent" && req.templateAllowedTools && req.templateAllowedTools.length > 0) {
    const allowed = new Set(req.templateAllowedTools);
    result = all.filter(t => allowed.has(t.name) || ALWAYS_ON_TOOLS.has(t.name));
  }

  return result;
}

function resolveMainChat(req: ResolveRequest, all: ToolDefinition[]): ToolDefinition[] {
  const msg = req.message ?? "";
  const literalCalls = req.literalCallDetector
    ? req.literalCallDetector(msg, all)
    : new Set<string>();
  const keyworded = req.keywordRouter
    ? req.keywordRouter(msg, all)
    : new Set<string>();

  // Build-intent strip-down. If the user message is "build me X" AND they
  // didn't paste a literal tool call, narrow to build-intent audience.
  // Literal calls always win — even on build-intent matches. Keyword-routed
  // tools survive the strip-down too: a message that names an office
  // artifact ("power point", "spreadsheet") must keep those tools in the
  // schema even when the build classifier (mis)fires, or the model's only
  // visible "make something" tool is build_app (2026-06-10 misroute).
  if (req.buildIntentTest && req.buildIntentTest(msg) && literalCalls.size === 0) {
    return all.filter(t => t.audiences?.includes("build-intent") || keyworded.has(t.name));
  }

  const included = new Set<string>();
  for (const t of all) {
    if (t.audiences?.includes("main-chat")) included.add(t.name);
  }
  for (const name of literalCalls) included.add(name);
  for (const name of keyworded) included.add(name);

  const prioritized = new Set([...literalCalls, ...keyworded]);
  return [
    ...all.filter(t => prioritized.has(t.name)),
    ...all.filter(t => included.has(t.name) && !prioritized.has(t.name)),
  ];
}

export const toolSearchEnhancements = {
  category: "system" as const,
  tags: ["search", "find", "tool", "discover"],
  readOnly: true,
  concurrencySafe: true,
  defer: false,
};

/**
 * Backwards-compatible alias. Real implementation lives in
 * src/tools/registry.ts as UnifiedToolRegistry. Existing call sites that
 * import { ToolRegistry } from "./tool-search.js" continue to work and
 * delegate to the same store.
 */
export { UnifiedToolRegistry as ToolRegistry } from "./registry.js";
export { unifiedRegistry } from "./registry.js";

export function createToolSearchTool(registry: UnifiedToolRegistry): ToolDefinition {
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
