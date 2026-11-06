/**
 * A tool the model loads with tool_search must not change the front of the
 * prompt. Prefix order is tools → system → messages, so adding a tool to the
 * request's tool list rewrote the very first bytes: every request after a load
 * read the whole system prompt and conversation back in uncached.
 *
 * Claude can load a tool inline instead. A tool marked `defer_loading` is sent
 * in `tools` but kept out of the prompt; a `tool_reference` block in a tool
 * result expands into its definition at that point in the conversation. So on
 * this wire, each tool a tool_search result loaded is sent deferred, and that
 * result becomes references to it: everything before the result is
 * byte-identical to the request before, and the cache holds.
 *
 * A pure function of the history and the tool list, as the cache needs
 * (cache-prefix rule): the loaded names are read from the result itself, which
 * pruning never stubs (context-manager/prune-tool-results.ts). Verified on the
 * subscription (OAuth) route, 2026-11-06: a result of only tool_reference
 * blocks loads and the model calls the tool; text beside a reference is a 400
 * ("Tool definitions ... cannot be mixed with other content"), so a result is
 * references only, or left as text when it loaded nothing this request carries.
 */
import type { AnthropicContent, AnthropicMessage, ToolReference } from "./types.js";
import { toolSearchResultNames } from "../tools/tool-search-result.js";
import { unifiedRegistry } from "../tools/registry.js";

const SEARCH_TOOL = "tool_search";

/** Claude models that take `defer_loading` and `tool_reference`: 4.5 and later. */
export function supportsDeferredTools(model: string): boolean {
  return /^claude-(opus|sonnet|haiku|fable|mythos)-(4-[5-9]|[5-9])/.test(model);
}

/**
 * Each tool_search result whose loaded tools are in this request's tool list
 * becomes references to them, and those tools are returned to send deferred.
 * `wireName` maps a LAX tool name to the name the request carries (the OAuth
 * route renames some). Messages are converted Anthropic messages; the input is
 * not mutated.
 */
export function referenceSearchLoads(
  messages: readonly AnthropicMessage[],
  toolNames: ReadonlySet<string>,
  wireName: (name: string) => string = (n) => n,
): { messages: AnthropicMessage[]; deferred: Set<string> } {
  const searchCalls = new Set<string>();
  const deferred = new Set<string>();
  const out = messages.map((m) => {
    if (!Array.isArray(m.content)) return m;
    let changed = false;
    const content = m.content.map((block): AnthropicContent => {
      if (block.type === "tool_use" && block.name === SEARCH_TOOL) searchCalls.add(block.id);
      if (block.type !== "tool_result" || !searchCalls.has(block.tool_use_id) || typeof block.content !== "string") return block;
      const loaded = [...new Set(toolSearchResultNames(block.content))].filter((n) => toolNames.has(n));
      if (loaded.length === 0) return block;
      changed = true;
      for (const n of loaded) deferred.add(n);
      const refs: ToolReference[] = loaded.map((n) => ({ type: "tool_reference", tool_name: wireName(n) }));
      return { ...block, content: refs };
    });
    return changed ? { ...m, content } : m;
  });
  return { messages: out, deferred };
}

type WireTool = { name: string; description: string; parameters: Record<string, unknown> };

/**
 * One registered tool this request does not carry, to send deferred and never
 * reference. Measured on the subscription route (2026-11-06): the FIRST
 * deferred tool in a conversation switches the request into deferred-loading
 * mode, which rewrites the cached prefix (~93 tokens, the whole cache missed);
 * once one is present, which ones are present — added, swapped, removed,
 * reordered — never touches the cache. So every request carries one from the
 * start, and a later load costs nothing. A native tool (an MCP server's schema
 * is not ours to vouch for), the first by name, so the choice is stable.
 */
export function deferredAnchor(carried: ReadonlySet<string>): WireTool | undefined {
  const tool = unifiedRegistry.getAll()
    .filter((t) => !carried.has(t.name) && !unifiedRegistry.getEntry(t.name)?.mcpSource)
    .sort((a, b) => a.name.localeCompare(b.name))[0];
  return tool && { name: tool.name, description: tool.description, parameters: tool.parameters as Record<string, unknown> };
}

/**
 * This request's messages, the tools to send, and which of them go deferred:
 * tools tool_search loaded, plus the anchor that keeps deferred loading on
 * from the first request. Only on a model that takes deferred loading; the API
 * needs at least one tool loaded up front, which tool_search always is.
 */
export function deferSearchLoads<T extends WireTool>(
  model: string,
  messages: AnthropicMessage[],
  tools: readonly T[] | undefined,
  wireName?: (name: string) => string,
  anchor: (carried: ReadonlySet<string>) => WireTool | undefined = deferredAnchor,
): { messages: AnthropicMessage[]; tools: readonly WireTool[] | undefined; deferred: Set<string> } {
  const unchanged = { messages, tools, deferred: new Set<string>() };
  if (!tools?.length || !supportsDeferredTools(model)) return unchanged;
  const names = new Set(tools.map((t) => t.name));
  const view = referenceSearchLoads(messages, names, wireName);
  if (view.deferred.size >= tools.length) return unchanged;
  const extra = anchor(names);
  if (extra) view.deferred.add(extra.name);
  return { messages: view.messages, tools: extra ? [...tools, extra] : tools, deferred: view.deferred };
}
