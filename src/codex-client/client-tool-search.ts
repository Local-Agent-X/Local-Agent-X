/**
 * A tool the model loads with tool_search must not change the front of the
 * prompt (the Claude side of this: anthropic-client/deferred-tools.ts). The
 * Responses API has its own form: a `tool_search` tool run by the client, whose
 * `tool_search_output` carries the loaded tools' definitions inline, appended to
 * the conversation; the top-level `tools` never changes.
 *
 * So on this wire LAX's tool_search function goes out as that tool, each call
 * and result replays as `tool_search_call` / `tool_search_output`, and a tool a
 * search loaded is left out of `tools`: its definition rides in the output that
 * loaded it. A pure function of the history and the tool list, as the cache
 * needs; the loaded names are read from the result, which pruning never stubs.
 * Verified on the ChatGPT subscription endpoint, 2026-11-06: the model calls
 * the tool_search tool, and calls a tool its output loaded.
 */
import type { CodexTool } from "./types.js";
import { toolSearchResultNames } from "../tools/tool-search-result.js";

const SEARCH_TOOL = "tool_search";

/** The Responses API's client-run tool search entry. */
export interface ClientToolSearchTool {
  type: "tool_search";
  execution: "client";
  description: string;
  parameters: Record<string, unknown>;
}

/** Models with tool search on the Responses API: gpt-5.4 and later. */
export function supportsClientToolSearch(model: string): boolean {
  return /^gpt-(5\.([4-9]|\d{2,})|([6-9]|\d{2,})(\.|-|$))/i.test(model);
}

type Item = Record<string, unknown>;

/**
 * The request's input items and tools with tool_search on the client-run form.
 * Unchanged when the request carries no tool_search function or the model has
 * no tool search.
 */
export function withClientToolSearch(
  model: string,
  input: readonly unknown[],
  tools: readonly CodexTool[] | undefined,
): { input: unknown[]; tools: Array<CodexTool | ClientToolSearchTool> | undefined } {
  const search = tools?.find((t) => t.name === SEARCH_TOOL);
  if (!tools || !search || !supportsClientToolSearch(model)) return { input: [...input], tools: tools && [...tools] };
  const byName = new Map(tools.map((t) => [t.name, t]));
  const searchCalls = new Set<string>();
  const loaded = new Set<string>();
  const out = input.map((raw) => {
    const item = raw as Item;
    if (item.type === "function_call" && item.name === SEARCH_TOOL) {
      searchCalls.add(String(item.call_id));
      let args: unknown = {};
      try { args = JSON.parse(String(item.arguments ?? "{}")); } catch { /* a malformed call replays with no arguments */ }
      return { type: "tool_search_call", execution: "client", call_id: item.call_id, ...(item.id ? { id: item.id } : {}), status: "completed", arguments: args };
    }
    if (item.type === "function_call_output" && searchCalls.has(String(item.call_id))) {
      const names = [...new Set(toolSearchResultNames(String(item.output ?? "")))].filter((n) => byName.has(n) && n !== SEARCH_TOOL);
      for (const n of names) loaded.add(n);
      const defs = names.map((n) => ({ ...byName.get(n)!, defer_loading: true }));
      return { type: "tool_search_output", execution: "client", call_id: item.call_id, status: "completed", tools: defs };
    }
    return raw;
  });
  const clientSearch: ClientToolSearchTool = { type: "tool_search", execution: "client", description: search.description, parameters: search.parameters };
  const sent = tools.filter((t) => !loaded.has(t.name)).map((t) => (t.name === SEARCH_TOOL ? clientSearch : t));
  return { input: out, tools: sent };
}
